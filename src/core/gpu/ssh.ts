// SSH to the rented instance (owner: gpu): app key management, an ssh2 connection wrapper with exec, and a
// local TCP port forward (127.0.0.1:<localPort> → remote 127.0.0.1:8080) that survives SSH reconnects.

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import ssh2 from 'ssh2';
import type { ClientChannel } from 'ssh2';
import type { SecretStore } from '../contracts';
import type { SshTarget } from './vast-client';

export const SSH_PRIVATE_KEY_SECRET = 'vast.sshPrivateKey';
export const SSH_KEY_COMMENT = 'obsidian-code';

export interface AppKey { privateKey: string; publicKey: string }

function publicFromPrivate(privateKey: string): string | null {
  const parsed = ssh2.utils.parseKey(privateKey);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error || key.type !== 'ssh-ed25519') return null;
  const blob = key.getPublicSSH();
  // ssh-ed25519 wire blob = string "ssh-ed25519" (4+11) + string pubkey (4+32) = 51 bytes
  if (!blob || blob.length !== 51) return null;
  return `${key.type} ${blob.toString('base64')} ${SSH_KEY_COMMENT}`;
}

/**
 * Generate an ed25519 key pair with ssh2, validating the result: ssh2's generator emits a malformed key (a 31-byte
 * public key) for ~0.4% of keys, so parse it back and retry until it round-trips.
 */
export function generateValidEd25519(comment = SSH_KEY_COMMENT): { private: string; public: string } {
  for (let i = 0; i < 50; i++) {
    const kp = ssh2.utils.generateKeyPairSync('ed25519', { comment });
    const pub = publicFromPrivate(kp.private);
    if (pub && pub.split(' ')[1] === kp.public.trim().split(/\s+/)[1]) return { private: kp.private, public: kp.public.trim() };
  }
  throw new Error('Could not generate a valid ed25519 SSH key');
}

/** The app's ed25519 key: generated once, private key kept in the secret store (regenerated if unreadable). */
export function ensureAppKey(secrets: SecretStore): AppKey {
  const existing = secrets.get(SSH_PRIVATE_KEY_SECRET);
  if (existing) {
    const pub = publicFromPrivate(existing);
    if (pub) return { privateKey: existing, publicKey: pub };
  }
  const kp = generateValidEd25519();
  secrets.set(SSH_PRIVATE_KEY_SECRET, kp.private);
  return { privateKey: kp.private, publicKey: kp.public };
}

export interface ExecResult { code: number | null; stdout: string; stderr: string }

/** The server answered but rejected the app key (ssh2: "All configured authentication methods failed"). */
export function isSshAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /authentication methods failed|permission denied \(publickey/i.test(msg);
}

export interface SshConnectionOptions {
  privateKey: string;
  readyTimeoutMs?: number;
  keepaliveMs?: number;
  /** Trust-on-first-use host key fingerprints (sha256 hex) per "host:port". */
  hostKeys?: Map<string, string>;
}

const MAX_OUTPUT = 2 * 1024 * 1024;

type Ssh2Client = InstanceType<typeof ssh2.Client>;

export class SshConnection {
  private client: Ssh2Client | null = null;
  private connected = false;
  private closedByUs = false;
  target: SshTarget | null = null;
  /** Called once when an established connection drops (not when we end() it). */
  onLost: ((err?: Error) => void) | null = null;
  readonly hostKeys: Map<string, string>;

  constructor(private readonly opts: SshConnectionOptions) {
    this.hostKeys = opts.hostKeys ?? new Map();
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  /** Try each target in order (direct first, then proxy). Resolves with the target that worked. */
  async connect(targets: SshTarget[], signal?: AbortSignal): Promise<SshTarget> {
    if (targets.length === 0) throw new Error('The instance has no SSH endpoint yet.');
    let lastErr: unknown = null;
    let authErr: Error | null = null;
    for (const t of targets) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      try {
        await this.connectOne(t);
        return t;
      } catch (err) {
        lastErr = err;
        // A reachable sshd that rejects the key says more than another target's timeout: report that one.
        if (err instanceof Error && isSshAuthError(err)) authErr ??= err;
      }
    }
    if (authErr) throw authErr;
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private connectOne(t: SshTarget): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = new ssh2.Client();
      let settled = false;
      let lastError: Error | undefined;
      const fpKey = `${t.host}:${t.port}`;
      c.on('ready', () => {
        if (settled) return;
        settled = true;
        const old = this.client;
        this.client = c;
        this.connected = true;
        this.closedByUs = false;
        this.target = t;
        if (old && old !== c) {
          try {
            old.end();
          } catch {
            /* ignore */
          }
        }
        resolve();
      });
      c.on('error', (err: Error) => {
        lastError = err;
        if (!settled) {
          settled = true;
          try {
            c.end();
          } catch {
            /* ignore */
          }
          reject(err);
        }
      });
      c.on('close', () => {
        if (!settled) {
          settled = true;
          reject(lastError ?? new Error(`SSH connection to ${fpKey} closed during handshake`));
          return;
        }
        if (this.client === c) {
          this.connected = false;
          this.client = null;
          if (!this.closedByUs) this.onLost?.(lastError);
        }
      });
      try {
        c.connect({
          host: t.host,
          port: t.port,
          username: 'root',
          privateKey: this.opts.privateKey,
          readyTimeout: this.opts.readyTimeoutMs ?? 20_000,
          keepaliveInterval: this.opts.keepaliveMs ?? 15_000,
          keepaliveCountMax: 3,
          hostHash: 'sha256',
          hostVerifier: (hash: string) => {
            const known = this.hostKeys.get(fpKey);
            if (known && known !== hash) return false; // host key changed: refuse (possible MITM)
            this.hostKeys.set(fpKey, hash);
            return true;
          },
        });
      } catch (err) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  exec(cmd: string, opts: { timeoutMs?: number; stdin?: string | Buffer } = {}): Promise<ExecResult> {
    const c = this.client;
    if (!c || !this.connected) return Promise.reject(new Error('SSH is not connected'));
    const timeoutMs = opts.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      let finished = false;
      let stream: ClientChannel | null = null;
      let stdout = '';
      let stderr = '';
      let code: number | null = null;
      const finish = (err: Error | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve({ code, stdout, stderr });
      };
      const timer = setTimeout(() => {
        finish(new Error(`SSH command timed out after ${Math.round(timeoutMs / 1000)} s`));
        try {
          stream?.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      try {
        c.exec(cmd, (err, ch) => {
          if (err) return finish(err);
          stream = ch;
          ch.on('data', (d: Buffer) => {
            if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
          });
          ch.stderr.on('data', (d: Buffer) => {
            if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
          });
          ch.on('exit', (exitCode: number | null) => {
            code = typeof exitCode === 'number' ? exitCode : null;
          });
          ch.on('close', () => finish(null));
          ch.on('error', (e: Error) => finish(e));
          if (opts.stdin !== undefined) ch.end(opts.stdin);
          else ch.end();
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  forwardOut(srcPort: number, dstHost: string, dstPort: number): Promise<ClientChannel> {
    const c = this.client;
    if (!c || !this.connected) return Promise.reject(new Error('SSH is not connected'));
    return new Promise((resolve, reject) => {
      try {
        c.forwardOut('127.0.0.1', srcPort, dstHost, dstPort, (err, ch) => (err ? reject(err) : resolve(ch)));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  end(): void {
    this.closedByUs = true;
    this.connected = false;
    const c = this.client;
    this.client = null;
    if (c) {
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Local port forward that resolves the current SSH connection per incoming socket (so reconnects are transparent). */
export class LocalTunnel {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  port = 0;

  constructor(
    private readonly getConn: () => SshConnection | null,
    private readonly remoteHost = '127.0.0.1',
    private readonly remotePort = 8080,
  ) {}

  get listening(): boolean {
    return this.server !== null;
  }

  /** Listen on 127.0.0.1:preferredPort, falling back to an ephemeral port if it is taken. */
  async listen(preferredPort: number): Promise<number> {
    if (this.server) return this.port;
    try {
      return await this.listenOn(preferredPort);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' || code === 'EACCES') return this.listenOn(0);
      throw err;
    }
  }

  private listenOn(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => this.handle(sock));
      const onErr = (err: Error) => reject(err);
      srv.once('error', onErr);
      srv.listen(port, '127.0.0.1', () => {
        srv.off('error', onErr);
        srv.on('error', () => {
          /* keep the process alive on late errors */
        });
        this.server = srv;
        this.port = (srv.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  private handle(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => sock.destroy());
    const conn = this.getConn();
    if (!conn || !conn.isConnected()) {
      sock.destroy();
      return;
    }
    sock.pause();
    conn.forwardOut(sock.remotePort ?? 0, this.remoteHost, this.remotePort).then(
      (ch) => {
        if (sock.destroyed) {
          ch.close();
          return;
        }
        ch.on('error', () => sock.destroy());
        ch.on('close', () => sock.destroy());
        sock.on('close', () => {
          try {
            ch.close();
          } catch {
            /* ignore */
          }
        });
        sock.pipe(ch);
        ch.pipe(sock);
        sock.resume();
      },
      () => sock.destroy(),
    );
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const srv = this.server;
    this.server = null;
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
  }
}
