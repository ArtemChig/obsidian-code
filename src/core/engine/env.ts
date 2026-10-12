// Claude Code process environment + executable resolution for the claude-code engine (and scripts/claude-code-spike.ts).
// See docs/research/claude-agent-sdk.md for why each variable is set.

import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Inherited variables that would redirect, re-authenticate or reconfigure the child Claude Code process. */
const STRIP_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'AWS_BEARER_TOKEN_BEDROCK'];
const STRIP_EXACT = new Set(['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'ELECTRON_RUN_AS_NODE', 'MAX_THINKING_TOKENS', 'API_TIMEOUT_MS', 'DISABLE_AUTOUPDATER']);

export interface ClaudeEnvInput {
  baseEnv: NodeJS.ProcessEnv;
  /** Endpoint base URL as the model registry reports it (with or without a trailing /v1). */
  baseUrl: string;
  apiKey?: string;
  /** Served model id (llama.cpp alias). Must not contain '/' (Claude Code treats it as a provider prefix). */
  model: string;
  contextLength: number;
  configDir: string;
  extraEnv?: Record<string, string>;
  appVersion?: string;
}

/** Anthropic base URL for Claude Code: the server root (Claude Code appends /v1/messages itself). */
export function anthropicBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function maxOutputTokens(contextLength: number): number {
  return Math.max(1024, Math.min(16_384, Math.floor((contextLength || 32_768) / 4)));
}

export function buildClaudeEnv(o: ClaudeEnvInput): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(o.baseEnv)) {
    const K = k.toUpperCase();
    if (STRIP_EXACT.has(K) || STRIP_PREFIXES.some((p) => K.startsWith(p))) continue;
    env[k] = v;
  }
  const ctx = Math.max(4096, Math.floor(o.contextLength || 32_768));
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: o.configDir,
    ANTHROPIC_BASE_URL: anthropicBaseUrl(o.baseUrl),
    ANTHROPIC_AUTH_TOKEN: o.apiKey || 'local',
    ANTHROPIC_MODEL: o.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: o.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: o.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: o.model,
    ANTHROPIC_SMALL_FAST_MODEL: o.model,
    CLAUDE_CODE_SUBAGENT_MODEL: o.model,
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(ctx),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens(ctx)),
    CLAUDE_CODE_MAX_RETRIES: '2',
    // slow local prefill: llama.cpp sends no bytes until the first token, so the 5-minute body idle watchdog must be off
    API_TIMEOUT_MS: '1800000',
    API_FORCE_IDLE_TIMEOUT: '0',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: `obsidian-code/${o.appVersion ?? '0.1.0'}`,
  });
  for (const [k, v] of Object.entries(o.extraEnv ?? {})) {
    if (typeof k === 'string' && k.trim() && typeof v === 'string') env[k.trim()] = v;
  }
  return env;
}

export interface ExecutableInfo {
  /** Absolute path to a claude executable, or null when none was found. */
  path: string | null;
  source: 'sdk' | 'custom' | 'installed' | 'none';
  /** Claude Code version when known without spawning (the SDK's bundled binary). */
  version?: string;
  sdkVersion?: string;
  error?: string;
}

function nodeRequire(): NodeJS.Require {
  // CommonJS bundle (Electron main) / tsx: the real require. Elsewhere (vitest ESM): resolve from the project root.
  if (typeof require === 'function' && typeof require.resolve === 'function') return require;
  return createRequire(join(process.cwd(), 'package.json'));
}

/** app.asar/... is a virtual path: native binaries are shipped in app.asar.unpacked (electron-builder asarUnpack). */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2');
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function readJson(req: NodeJS.Require, id: string): Record<string, unknown> | null {
  try { return req(id) as Record<string, unknown>; } catch { return null; }
}

/** The installed Claude Code CLI (native installer location, then PATH). */
export function findInstalledClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [join(homedir(), '.local', 'bin', exe)];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) if (dir.trim()) candidates.push(join(dir.trim(), exe));
  return candidates.find(isFile) ?? null;
}

/**
 * Resolve the Claude Code executable. 'auto' = the native binary the Agent SDK ships in its per-platform optional
 * package (@anthropic-ai/claude-agent-sdk-<platform>-<arch>), unpacked from the asar when packaged; falls back to the
 * user's installed claude. Anything else is an explicit path.
 */
export function resolveClaudeExecutable(setting: string | undefined): ExecutableInfo {
  const req = nodeRequire();
  const sdkPkg = readJson(req, '@anthropic-ai/claude-agent-sdk/package.json');
  const sdkVersion = typeof sdkPkg?.version === 'string' ? sdkPkg.version : undefined;
  const value = (setting ?? 'auto').trim();
  if (value && value !== 'auto') {
    return isFile(value)
      ? { path: value, source: 'custom', sdkVersion }
      : { path: null, source: 'none', sdkVersion, error: `Claude Code executable not found: ${value}` };
  }
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const variants = process.platform === 'linux' ? [`linux-${process.arch}`, `linux-${process.arch}-musl`] : [`${process.platform}-${process.arch}`];
  for (const v of variants) {
    try {
      const p = unpackedPath(req.resolve(`@anthropic-ai/claude-agent-sdk-${v}/${bin}`));
      if (isFile(p)) {
        const version = typeof sdkPkg?.claudeCodeVersion === 'string' ? sdkPkg.claudeCodeVersion : undefined;
        return { path: p, source: 'sdk', version, sdkVersion };
      }
    } catch { /* optional package missing */ }
  }
  const installed = findInstalledClaude();
  if (installed) return { path: installed, source: 'installed', sdkVersion };
  return {
    path: null, source: 'none', sdkVersion,
    error: sdkVersion
      ? `The Claude Code binary for ${process.platform}-${process.arch} is missing (reinstall @anthropic-ai/claude-agent-sdk with optional dependencies) and no installed claude was found.`
      : 'The Claude Agent SDK is not installed.',
  };
}
