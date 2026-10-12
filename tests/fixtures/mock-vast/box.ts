// A fake rented instance for GPU pipeline tests (owner: gpu):
//   * an ssh2 Server that accepts only the account's registered/attached public keys,
//   * exec emulation of the commands the app runs (cat/touch/tail/switch/env/upload) against a temp dir that stands in
//     for /root/oc,
//   * direct-tcpip forwarding of remote 127.0.0.1:8080 to a mock llama-server (HTTP, Bearer API key),
//   * a simulated bootstrap that writes status.json: starting → downloading (progress) → loading → ready.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { Connection } from 'ssh2';
import { generateValidEd25519 } from '../../../src/core/gpu/ssh';

export interface BoxScenario {
  downloadSteps?: number;
  stepMs?: number;
  /** status.json → error during download. */
  failDownload?: boolean;
  /** Model ids that fail to load (status error). */
  failLoad?: string[];
  /** Override the /v1/models status (e.g. 503 → health check fails). */
  healthStatus?: number;
  /** The env-shipped bootstrap never starts (status.json stays "starting") until uploaded over SSH. */
  noBootstrap?: boolean;
  /** Never write status.json at all (onstart did not run). */
  noStatusFile?: boolean;
}

type ParsedPub = Exclude<ReturnType<typeof ssh2.utils.parseKey>, Error | unknown[]>;

export class FakeBox {
  readonly root: string;
  apiKey = '';
  modelId = '';
  env: Record<string, string> = {};
  heartbeats = 0;
  readonly execLog: string[] = [];
  readonly switches: string[] = [];
  readonly uploads: string[] = [];
  chatRequests = 0;
  modelsRequests = 0;
  sshPort = 0;
  llamaPort = 0;
  sshConnections = 0;
  readonly modelsOnDisk = new Set<string>();
  private llama: http.Server | null = null;
  private ssh: InstanceType<typeof ssh2.Server> | null = null;
  private readonly clients = new Set<Connection>();
  private timers = new Set<NodeJS.Timeout>();
  private serving = false;
  private runToken = 0;

  constructor(
    readonly instanceId: number,
    public scenario: BoxScenario,
    private readonly authorizedKeys: () => string[],
  ) {
    this.root = mkdtempSync(path.join(os.tmpdir(), `oc-box-${instanceId}-`));
  }

  private file(rel: string): string {
    return path.join(this.root, rel);
  }

  private mapPath(p: string): string {
    const m = /^\/root\/oc\/(.+)$/.exec(p);
    if (!m) throw new Error(`unsupported path ${p}`);
    return this.file(m[1]);
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  writeStatus(phase: string, progress: number, message: string, bytesDone = 0, bytesTotal = 0): void {
    writeFileSync(this.file('status.json'), JSON.stringify({ phase, progress, message, modelId: this.modelId, bytesDone, bytesTotal, updatedAt: Math.floor(Date.now() / 1000) }) + '\n');
  }

  private log(line: string): void {
    appendFileSync(this.file('server.log'), `${line}\n`);
  }

  async start(): Promise<void> {
    // mock llama-server
    this.llama = http.createServer((req, res) => {
      const ok = req.headers.authorization === `Bearer ${this.apiKey}`;
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        if (req.url === '/health') {
          res.writeHead(this.serving ? 200 : 503).end(this.serving ? '{"status":"ok"}' : '{"status":"loading"}');
          return;
        }
        if (!ok) {
          res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Invalid API Key"}}');
          return;
        }
        if (req.url === '/v1/models') {
          this.modelsRequests++;
          const st = this.scenario.healthStatus ?? (this.serving ? 200 : 503);
          res.writeHead(st, { 'Content-Type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: this.modelId, object: 'model' }] }));
          return;
        }
        if (req.url === '/v1/chat/completions' && req.method === 'POST') {
          this.chatRequests++;
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({ id: 'x', object: 'chat.completion', model: this.modelId, choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }),
          );
          return;
        }
        res.writeHead(404).end('not found');
      });
    });
    await new Promise<void>((r) => this.llama!.listen(0, '127.0.0.1', () => r()));
    this.llamaPort = (this.llama.address() as AddressInfo).port;

    // ssh server
    const hostKey = generateValidEd25519('mock-host').private;
    this.ssh = new ssh2.Server({ hostKeys: [hostKey] }, (client) => this.onClient(client));
    await new Promise<void>((r) => this.ssh!.listen(0, '127.0.0.1', () => r()));
    this.sshPort = (this.ssh.address() as AddressInfo).port;
  }

  private onClient(client: Connection): void {
    this.clients.add(client);
    client.on('close', () => this.clients.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
      for (const k of this.authorizedKeys()) {
        const parsed = ssh2.utils.parseKey(k);
        const pub = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedPub | Error;
        if (!pub || pub instanceof Error) continue;
        if (ctx.key.algo === pub.type && ctx.key.data.equals(pub.getPublicSSH())) {
          if (ctx.signature && ctx.blob && pub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject();
          return ctx.accept();
        }
      }
      ctx.reject();
    });
    client.on('ready', () => {
      this.sshConnections++;
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acc, _rej, info) => {
          const stream = acc();
          let stdin = '';
          stream.on('data', (d: Buffer) => (stdin += d.toString('utf8')));
          stream.on('end', () => {
            const r = this.exec(info.command, stdin);
            if (r.stdout) stream.write(r.stdout);
            if (r.stderr) stream.stderr.write(r.stderr);
            stream.exit(r.code);
            stream.end();
          });
        });
      });
      client.on('tcpip', (accept, reject, info) => {
        if (info.destPort !== 8080 || !['127.0.0.1', 'localhost'].includes(info.destIP)) return reject();
        const sock = net.connect(this.llamaPort, '127.0.0.1');
        sock.once('connect', () => {
          const ch = accept();
          ch.on('error', () => sock.destroy());
          sock.on('error', () => ch.close());
          sock.pipe(ch).pipe(sock);
        });
        sock.once('error', () => {
          try {
            reject();
          } catch {
            /* already accepted */
          }
        });
      });
    });
  }

  /** Simulate a network drop: kill every SSH connection. */
  dropConnections(): void {
    for (const c of this.clients) c.end();
  }

  private exec(command: string, stdin: string): { code: number; stdout: string; stderr: string } {
    this.execLog.push(command);
    // background start of the uploaded onstart stub
    if (/setsid nohup bash \/root\/oc\/onstart\.sh/.test(command)) {
      this.uploads.push('start');
      this.boot(this.env, true);
      return { code: 0, stdout: '', stderr: '' };
    }
    // `a; b` runs both; `a && b` stops the chain at the first failure (exit code of the last segment wins).
    let out = '';
    let err = '';
    let code = 0;
    for (const seq of command.split(/\s*;\s*/)) {
      const r = this.execChain(seq, stdin);
      out += r.stdout;
      err += r.stderr;
      code = r.code;
      if (r.code === 127) break;
    }
    return { code, stdout: out, stderr: err };
  }

  private execChain(command: string, stdin: string): { code: number; stdout: string; stderr: string } {
    let out = '';
    for (const part of command.split(' && ')) {
      const p = part.trim();
      let m: RegExpExecArray | null;
      if (/^mkdir -p \/root\/oc$/.test(p) || /^cd \/root\/oc$/.test(p)) continue;
      if ((m = /^echo (\S+)$/.exec(p))) {
        out += `${m[1]}\n`;
        continue;
      }
      if ((m = /^touch (\/root\/oc\/\S+)$/.exec(p))) {
        writeFileSync(this.mapPath(m[1]), '');
        if (m[1] === '/root/oc/heartbeat') this.heartbeats++;
        continue;
      }
      if ((m = /^cat (\/root\/oc\/\S+)( 2>\/dev\/null)?$/.exec(p))) {
        const f = this.mapPath(m[1]);
        if (!existsSync(f)) return { code: 1, stdout: out, stderr: m[2] ? '' : `cat: ${m[1]}: No such file or directory\n` };
        out += readFileSync(f, 'utf8');
        continue;
      }
      if ((m = /^tail -n (\d+) (.+?)( 2>\/dev\/null)?$/.exec(p))) {
        const n = Number(m[1]);
        for (const f of m[2].split(/\s+/)) {
          const fp = this.mapPath(f);
          if (existsSync(fp)) out += readFileSync(fp, 'utf8').split('\n').slice(-n - 1).join('\n');
        }
        continue;
      }
      if ((m = /^base64 -d > (\/root\/oc\/\S+)\.tmp$/.exec(p))) {
        const target = m[1];
        writeFileSync(this.mapPath(target), Buffer.from(stdin.trim(), 'base64'));
        this.uploads.push(path.basename(target));
        continue;
      }
      if (/^mv -f \/root\/oc\/\S+ \/root\/oc\/\S+$/.test(p)) continue;
      if ((m = /^bash \/root\/oc\/switch\.sh '([^']+)'$/.exec(p))) {
        this.switches.push(m[1]);
        this.run(m[1], true);
        return { code: 0, stdout: `switching to ${m[1]}\n`, stderr: '' };
      }
      return { code: 127, stdout: out, stderr: `mock box: unsupported command: ${p}\n` };
    }
    return { code: 0, stdout: out, stderr: '' };
  }

  /** Instance became running: emulate the onstart stub (env file, status starting, then bootstrap). */
  boot(env: Record<string, string>, fromUpload = false): void {
    this.env = env;
    this.apiKey = env.OC_API_KEY ?? '';
    const lines = Object.entries(env)
      .filter(([k]) => !k.endsWith('_GZB64'))
      .map(([k, v]) => `export ${k}='${v}'`);
    writeFileSync(this.file('env'), lines.join('\n') + '\n');
    if (this.scenario.noStatusFile && !fromUpload) return;
    this.modelId = existsSync(this.file('current_model')) ? readFileSync(this.file('current_model'), 'utf8').trim() : env.OC_MODEL_ID ?? '';
    this.writeStatus('starting', 0, 'Instance booted');
    if (this.scenario.noBootstrap && !fromUpload) return;
    this.later(this.scenario.stepMs ?? 40, () => this.run(this.modelId, false));
  }

  /** Simulated bootstrap serve/switch for a model. */
  run(modelId: string, switching: boolean): void {
    const token = ++this.runToken;
    this.clearTimers();
    this.serving = false;
    this.modelId = modelId;
    writeFileSync(this.file('current_model'), modelId);
    const steps = this.scenario.downloadSteps ?? 3;
    const stepMs = this.scenario.stepMs ?? 40;
    const total = 1_000_000;
    let i = 0;
    const onDisk = this.modelsOnDisk.has(modelId);
    if (switching) this.writeStatus('switching', 0, `Switching to ${modelId}`, 0, total);
    const next = () => {
      if (token !== this.runToken) return;
      if (!onDisk && i < steps) {
        i++;
        if (this.scenario.failDownload && i === 2) {
          this.writeStatus('error', 0, `Model download failed (${modelId})`);
          this.log('ERROR: download failed');
          return;
        }
        this.writeStatus('downloading', i / steps, `Downloading ${modelId}`, Math.round((i / steps) * total), total);
        this.later(stepMs, next);
        return;
      }
      this.modelsOnDisk.add(modelId);
      this.writeStatus('loading', 0, `Loading ${modelId} into VRAM`, total, total);
      this.later(stepMs, () => {
        if (token !== this.runToken) return;
        if (this.scenario.failLoad?.includes(modelId)) {
          this.writeStatus('error', 0, `llama-server failed to load ${modelId}; see server.log`);
          this.log(`ERROR: failed to load ${modelId}`);
          return;
        }
        this.serving = true;
        this.writeStatus('ready', 1, `Serving ${modelId}`, total, total);
        writeFileSync(this.file('was_ready'), '');
        this.log(`ready: ${modelId}`);
      });
    };
    this.later(stepMs, next);
  }

  /** Instance stopped (park): processes die, the disk (this.root + modelsOnDisk) stays. */
  stopProcesses(): void {
    this.runToken++;
    this.clearTimers();
    this.serving = false;
    this.dropConnections();
  }

  async close(): Promise<void> {
    this.stopProcesses();
    for (const c of this.clients) c.end();
    const s = this.ssh;
    const l = this.llama;
    this.ssh = null;
    this.llama = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    if (l) {
      l.closeAllConnections?.();
      await new Promise<void>((r) => l.close(() => r()));
    }
    try {
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  ensureDir(): void {
    mkdirSync(this.root, { recursive: true });
  }
}
