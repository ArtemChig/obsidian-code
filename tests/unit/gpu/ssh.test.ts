import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import ssh2 from 'ssh2';
import type { SecretStore } from '../../../src/core/contracts';
import { LocalTunnel, SshConnection, ensureAppKey, generateValidEd25519, SSH_PRIVATE_KEY_SECRET } from '../../../src/core/gpu/ssh';
import { FakeBox } from '../../fixtures/mock-vast/box';

function memSecrets(seed: Record<string, string> = {}): SecretStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return { map, get: (n) => map.get(n) ?? null, set: (n, v) => void (v === null ? map.delete(n) : map.set(n, v)), has: (n) => map.has(n) };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('app SSH key', () => {
  it('generateValidEd25519 always round-trips (works around ssh2 emitting 31-byte public keys)', () => {
    for (let i = 0; i < 1500; i++) {
      const kp = generateValidEd25519();
      const parsed = ssh2.utils.parseKey(kp.private);
      expect(parsed instanceof Error).toBe(false);
      expect(kp.public.startsWith('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI')).toBe(true);
    }
  });

  it('is generated once, kept in secrets, and regenerated if the stored key is unreadable', () => {
    const s = memSecrets();
    const a = ensureAppKey(s);
    expect(s.map.get(SSH_PRIVATE_KEY_SECRET)).toBe(a.privateKey);
    expect(ensureAppKey(s)).toEqual(a);
    expect(a.publicKey).toMatch(/^ssh-ed25519 \S+ obsidian-code$/);
    s.map.set(SSH_PRIVATE_KEY_SECRET, 'garbage');
    const b = ensureAppKey(s);
    expect(b.privateKey).not.toBe('garbage');
    expect(b.publicKey).not.toBe(a.publicKey);
  });
});

describe('SshConnection + LocalTunnel', () => {
  it('rejects a changed host key (TOFU) and connects with the right one', async () => {
    const key = generateValidEd25519();
    const box = new FakeBox(1, {}, () => [key.public]);
    await box.start();
    cleanups.push(() => box.close());
    const target = { host: '127.0.0.1', port: box.sshPort, kind: 'direct' as const };

    const pinned = new Map([[`127.0.0.1:${box.sshPort}`, 'deadbeef']]);
    const bad = new SshConnection({ privateKey: key.private, hostKeys: pinned, readyTimeoutMs: 5000 });
    await expect(bad.connect([target])).rejects.toThrow();
    bad.end();

    const good = new SshConnection({ privateKey: key.private, readyTimeoutMs: 5000 });
    await good.connect([target]);
    cleanups.push(() => good.end());
    expect(good.isConnected()).toBe(true);
    expect(good.hostKeys.get(`127.0.0.1:${box.sshPort}`)).toMatch(/^[0-9a-f]{64}$/);
    box.writeStatus('starting', 0, 'x');
    const r = await good.exec('cat /root/oc/status.json');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).phase).toBe('starting');

    // wrong client key is refused
    const other = generateValidEd25519();
    const stranger = new SshConnection({ privateKey: other.private, readyTimeoutMs: 5000 });
    await expect(stranger.connect([target])).rejects.toThrow();
    stranger.end();
  });

  it('tunnel falls back to an ephemeral port when the preferred one is busy and refuses sockets while SSH is down', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const busy = (blocker.address() as AddressInfo).port;
    const tunnel = new LocalTunnel(() => null);
    cleanups.push(() => tunnel.close());
    const port = await tunnel.listen(busy);
    expect(port).not.toBe(busy);
    const closed = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('close', () => resolve(true));
      s.on('error', () => resolve(true));
    });
    expect(closed).toBe(true);
  });
});
