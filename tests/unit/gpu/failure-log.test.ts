// GPU failure evidence helpers: section parsing, secret stripping, file naming and the keep-20 rotation.
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVIDENCE_MARK, evidenceCommand, failureLogName, formatFailureLog, latestFailureLog, listFailureLogs, parseEvidence, redactSecrets, saveFailureLog,
} from '../../../src/core/gpu/failure-log';
import { catalogModelInfo } from '../../../src/core/gpu/provider';
import { getCatalogModel } from '../../../src/core/gpu/catalog';
import { parseServerStatus } from '../../../src/core/gpu/server-scripts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'oc-flog-'));
  dirs.push(d);
  return d;
}

describe('failure evidence', () => {
  it('one command fetches every section; the output splits back into sections', () => {
    const cmd = evidenceCommand();
    for (const part of ['tail -n 400 /root/oc/server.log', 'tail -n 200 /root/oc/bootstrap.log', 'cat /root/oc/status.json', '/root/oc/watchdog.log', 'nvidia-smi']) {
      expect(cmd).toContain(part);
    }
    const out = `${EVIDENCE_MARK}status.json\n{"phase":"error"}\n${EVIDENCE_MARK}server.log\nline 1\nline 2\n\n${EVIDENCE_MARK}nvidia-smi\nNVIDIA-SMI 575\n`;
    const s = parseEvidence(out);
    expect(s.get('status.json')).toBe('{"phase":"error"}');
    expect(s.get('server.log')).toBe('line 1\nline 2');
    expect(s.get('nvidia-smi')).toBe('NVIDIA-SMI 575');
    const text = formatFailureLog({ reason: 'GPU server error: x', instanceId: 42, capturedAt: Date.UTC(2026, 9, 13, 11, 2, 3), modelId: 'm' }, s);
    expect(text).toContain('Reason:    GPU server error: x');
    expect(text).toContain('===== server.log (last 400 lines) =====\nline 1\nline 2');
    expect(text).toContain('===== bootstrap.log (last 200 lines) =====\n(empty or not available)');
  });

  it('strips API keys and tokens', () => {
    const key = 'a'.repeat(64);
    const raw = [
      `starting: /app/llama-server --api-key ${key} --alias m`,
      "export OC_API_KEY='0123456789abcdef'",
      'CONTAINER_API_KEY=ckey-777 OC_MODEL_ID=m',
      'curl -H "Authorization: Bearer abc.def-123456"',
      '{"api_key": "sk-live-xyz", "HF_TOKEN":"hf_abcdefgh"}',
      'unknown secret value supersecretvalue in a message',
      'n_ctx = 65536, type_k = q8_0 (kept)',
    ].join('\n');
    const t = redactSecrets(raw, ['supersecretvalue', null, '']);
    for (const s of [key, '0123456789abcdef', 'ckey-777', 'abc.def-123456', 'sk-live-xyz', 'hf_abcdefgh', 'supersecretvalue']) expect(t).not.toContain(s);
    expect(t).toContain('--api-key ***');
    expect(t).toContain("OC_API_KEY='***'");
    expect(t).toContain('Bearer ***');
    expect(t).toContain('OC_MODEL_ID=m');
    expect(t).toContain('n_ctx = 65536, type_k = q8_0 (kept)');
  });

  it('saves gpu-<id>-<YYYYMMDD-HHMMSS>.log under <dataDir>/logs and keeps the newest 20', () => {
    const dataDir = tmp();
    const at = new Date(2026, 9, 13, 7, 2, 3).getTime();
    expect(failureLogName(26418220, at)).toBe('gpu-26418220-20261013-070203.log');
    const first = saveFailureLog(dataDir, 1, 'first', at);
    expect(first).toBe(path.join(dataDir, 'logs', 'gpu-1-20261013-070203.log'));
    expect(saveFailureLog(dataDir, 1, 'same second', at)).toBe(path.join(dataDir, 'logs', 'gpu-1-20261013-070203-2.log'));
    for (const f of listFailureLogs(dataDir)) utimesSync(f.file, new Date(at), new Date(at));
    writeFileSync(path.join(dataDir, 'logs', 'unrelated.txt'), 'keep me');
    for (let i = 0; i < 24; i++) {
      const f = saveFailureLog(dataDir, 100 + i, `log ${i}`, at + (i + 1) * 1000);
      const t = new Date(at + (i + 1) * 1000);
      utimesSync(f, t, t);
    }
    const left = listFailureLogs(dataDir);
    expect(left).toHaveLength(20);
    expect(left[0].file).toContain('gpu-123-');
    expect(readdirSync(path.join(dataDir, 'logs'))).toContain('unrelated.txt');
    expect(latestFailureLog(dataDir)?.text).toBe('log 23\n');
    expect(latestFailureLog(tmp())).toBeNull();
  });
});

describe('safe mode in status.json and the provider', () => {
  it('parses mode / dropped / attempt / ctx (and ignores unknown modes)', () => {
    expect(parseServerStatus('{"phase":"ready","progress":1,"message":"","modelId":"m","bytesDone":0,"bytesTotal":0,"mode":"safe","dropped":["mtp","vision"],"attempt":2,"ctx":65536}')).toMatchObject({
      mode: 'safe',
      dropped: ['mtp', 'vision'],
      attempt: 2,
      ctx: 65536,
    });
    expect(parseServerStatus('{"phase":"ready","mode":"weird"}')?.mode).toBeUndefined();
  });

  it('a model whose projector was dropped is not offered for images; context follows the server', () => {
    const m = getCatalogModel('qwen38-27b-uncensored-hauhau-q5kp')!;
    expect(catalogModelInfo(m, 'online')).toMatchObject({ supportsVision: true, contextLength: 131072 });
    expect(catalogModelInfo(m, 'online', { droppedFeatures: ['mtp', 'vision'], serverContextLength: 65536 })).toMatchObject({ supportsVision: false, contextLength: 65536 });
  });
});
