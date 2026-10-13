// GPU failure evidence (owner: gpu). When a clock-in fails after SSH was connected, or the server crashes / falls back
// to a safe mode while clocked in, the manager fetches the server-side logs over SSH BEFORE the instance is destroyed
// (destroying it deletes them) and saves them to <dataDir>/logs/gpu-<instanceId>-<YYYYMMDD-HHMMSS>.log (newest 20 kept).
// Everything here is pure / node:fs only and never needs the network.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const FAILURE_LOG_KEEP = 20;
export const FAILURE_LOG_DIR = 'logs';
const FILE_RE = /^gpu-\d+-\d{8}-\d{6}(?:-\d+)?\.log$/;
/** Section marker echoed before each part of the evidence command (one token: survives any shell). */
export const EVIDENCE_MARK = '@@OC-EVIDENCE@@';

export const EVIDENCE_SECTIONS: readonly { id: string; title: string; cmd: string }[] = [
  { id: 'status.json', title: 'status.json', cmd: 'cat /root/oc/status.json 2>/dev/null' },
  { id: 'attempts.log', title: 'attempts.log (failed load attempts)', cmd: 'cat /root/oc/attempts.log 2>/dev/null' },
  { id: 'server.log', title: 'server.log (last 400 lines)', cmd: 'tail -n 400 /root/oc/server.log 2>/dev/null' },
  { id: 'bootstrap.log', title: 'bootstrap.log (last 200 lines)', cmd: 'tail -n 200 /root/oc/bootstrap.log 2>/dev/null' },
  { id: 'watchdog.log', title: 'watchdog.log (last 60 lines)', cmd: 'tail -n 60 /root/oc/watchdog.log 2>/dev/null' },
  { id: 'nvidia-smi', title: 'nvidia-smi', cmd: 'timeout 10 nvidia-smi 2>&1' },
];

/** When SSH never came up: the container's stdout/stderr fetched through the Vast API (PUT /instances/request_logs). */
export const CONTAINER_LOG_SECTION = { id: 'container.log', title: 'Vast container log (SSH was not connected)' } as const;

/** One SSH exec that prints every section, each preceded by `EVIDENCE_MARK<id>` on its own line. */
export function evidenceCommand(): string {
  return EVIDENCE_SECTIONS.map((s) => `echo ${EVIDENCE_MARK}${s.id}; ${s.cmd}`).join('; ');
}

export function parseEvidence(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) out.set(cur, buf.join('\n').replace(/\s+$/, ''));
  };
  for (const line of stdout.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith(EVIDENCE_MARK)) {
      flush();
      cur = line.slice(EVIDENCE_MARK.length).trim();
      buf = [];
    } else if (cur) buf.push(line);
  }
  flush();
  return out;
}

export interface FailureMeta {
  reason: string;
  instanceId: number;
  capturedAt: number;
  gpu?: string;
  modelId?: string;
  profileId?: string;
  image?: string;
  phase?: string;
  /** Why some sections are missing (timeout, SSH error). */
  note?: string;
}

export function formatFailureLog(meta: FailureMeta, sections: Map<string, string>): string {
  const lines = [
    'Obsidian Code - GPU failure log',
    `Captured:  ${new Date(meta.capturedAt).toISOString()}`,
    `Reason:    ${meta.reason}`,
    `Instance:  #${meta.instanceId}${meta.gpu ? ` (${meta.gpu})` : ''}`,
  ];
  if (meta.modelId) lines.push(`Model:     ${meta.modelId}`);
  if (meta.profileId) lines.push(`Profile:   ${meta.profileId}`);
  if (meta.image) lines.push(`Image:     ${meta.image}`);
  if (meta.phase) lines.push(`App phase: ${meta.phase}`);
  if (meta.note) lines.push(`Note:      ${meta.note}`);
  lines.push('');
  // Container-log-only evidence (SSH never connected): the SSH sections would all be empty noise.
  const containerOnly = sections.has(CONTAINER_LOG_SECTION.id) && EVIDENCE_SECTIONS.every((s) => !sections.has(s.id));
  if (!containerOnly) {
    for (const s of EVIDENCE_SECTIONS) {
      const body = sections.get(s.id);
      lines.push(`===== ${s.title} =====`, body && body.trim() ? body : '(empty or not available)', '');
    }
  }
  if (sections.has(CONTAINER_LOG_SECTION.id)) {
    const body = sections.get(CONTAINER_LOG_SECTION.id);
    lines.push(`===== ${CONTAINER_LOG_SECTION.title} =====`, body && body.trim() ? body : '(empty or not available)', '');
  }
  return lines.join('\n');
}

const ENV_SECRET = /\b((?:OC_API_KEY|CONTAINER_API_KEY|VAST_API_KEY|HF_TOKEN|HUGGING_FACE_HUB_TOKEN|[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET|PASSWORD))["']?\s*[=:]\s*)(["']?)([^\s"',;]+)/g;
const NAMED_SECRET = /\b((?:api[_-]?key|access[_-]?token|hf[_-]?token|password)["']?\s*[=:]\s*)(["']?)([^\s"',;]+)/gi;

/** Strip API keys and tokens: known secret values, Bearer tokens, KEY=value / "api_key": "…" pairs, --api-key <v>. */
export function redactSecrets(text: string, known: readonly (string | null | undefined)[] = []): string {
  let t = text;
  for (const k of known) if (k && k.length >= 8) t = t.split(k).join('***');
  t = t.replace(/\b(Bearer)\s+(?!\*\*\*)[A-Za-z0-9._~+/=-]{4,}/gi, '$1 ***');
  t = t.replace(ENV_SECRET, (_m, a: string, q: string, v: string) => (v.startsWith('***') ? `${a}${q}${v}` : `${a}${q}***`));
  t = t.replace(NAMED_SECRET, (_m, a: string, q: string, v: string) => (v.startsWith('***') ? `${a}${q}${v}` : `${a}${q}***`));
  t = t.replace(/(--api-key|--hf-token|-hft)(\s+|=)(?!\*\*\*)\S+/g, '$1$2***');
  return t;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** gpu-<instanceId>-<YYYYMMDD-HHMMSS>.log (local time, as seen in Explorer). */
export function failureLogName(instanceId: number, at: number): string {
  const d = new Date(at);
  return `gpu-${instanceId}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
}

export function failureLogDir(dataDir: string): string {
  return path.join(dataDir, FAILURE_LOG_DIR);
}

/** Saved failure logs, newest first. */
export function listFailureLogs(dataDir: string): { file: string; mtimeMs: number }[] {
  const dir = failureLogDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { file: string; mtimeMs: number }[] = [];
  for (const n of names) {
    if (!FILE_RE.test(n)) continue;
    try {
      out.push({ file: path.join(dir, n), mtimeMs: statSync(path.join(dir, n)).mtimeMs });
    } catch {
      /* vanished */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? 1 : a.file > b.file ? -1 : 0));
}

export function pruneFailureLogs(dataDir: string, keep = FAILURE_LOG_KEEP): void {
  for (const { file } of listFailureLogs(dataDir).slice(Math.max(0, keep))) {
    try {
      unlinkSync(file);
    } catch {
      /* in use / already gone */
    }
  }
}

/** Write the log (dir created; same-second name collisions get -2, -3…) and keep the newest `keep`. Returns its path. */
export function saveFailureLog(dataDir: string, instanceId: number, text: string, at: number, keep = FAILURE_LOG_KEEP): string {
  const dir = failureLogDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const base = failureLogName(instanceId, at);
  let file = path.join(dir, base);
  for (let i = 2; existsSync(file) && i < 100; i++) file = path.join(dir, base.replace(/\.log$/, `-${i}.log`));
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  pruneFailureLogs(dataDir, keep);
  return file;
}

export function latestFailureLog(dataDir: string): { file: string; text: string } | null {
  for (const { file } of listFailureLogs(dataDir)) {
    try {
      return { file, text: readFileSync(file, 'utf8') };
    } catch {
      /* try the next one */
    }
  }
  return null;
}
