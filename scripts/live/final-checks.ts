// Acceptance checks for the final live test (scripts/live/vast-live.ts final). No GPU, no app: reads what the run left
// in the test folder and its _evidence, runs the tests, drives the calculator in Playwright Chromium.
//
//   npx tsx scripts/live/final-checks.ts [--dir "E:\programming projects\Dedicated LLM\calculator-test"] [--run <driver out dir>]
//
// Writes _evidence/checks.json (+ node-test-output.txt, calculator*.png, net-audit-analysis.json) and prints PASS/FAIL.
//   a  Read tool call on PLAN.md (file reading on the user's PC)
//   b  web tool calls (mcp__obsidian__web_search → "WebSearch", WebFetch); index.html has "Orlando, FL — <n>°F, <conditions>
//      (as of …)" + an HTML comment with a source URL; no runtime weather API call; the temperature is within ±8°F of an
//      independent reading taken during the run (wttr.in / api.weather.gov, _evidence/weather-reference.json)
//   c  the six files exist
//   d  node --test: >= 12 tests, all pass; node -e "require('./calc.js')" works
//   e  Chromium: screenshot, 2 + 3 × 4 = shows 20, 1 ÷ 0 = shows Error
//   f  Claude Code harness: engine claude-code, thinking blocks, tool cards/todos in the screenshots, net audit without
//      Anthropic / claude.ai endpoints
//   g  clock-out verified, nothing left on Vast (the driver's result)

import { spawnSync } from 'node:child_process';
import { promises as dns } from 'node:dns';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import type { Message, Session, ToolUseBlock } from '../../src/shared/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const DIR = arg('dir') ?? 'E:\\programming projects\\Dedicated LLM\\calculator-test';
const EV = path.join(DIR, '_evidence');
const FILES = ['index.html', 'style.css', 'calc.js', 'app.js', 'calc.test.js', 'README.md'];

interface Check { id: string; name: string; pass: boolean; evidence: string[] }
const checks: Check[] = [];
function record(id: string, name: string, pass: boolean, evidence: string[]): void {
  checks.push({ id, name, pass, evidence });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}. ${name}`);
  for (const e of evidence) console.log(`        ${e}`);
}

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function toolsOf(messages: Message[]): ToolUseBlock[] {
  return messages.flatMap((m) => m.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'));
}

// ── a, b (tool calls), f (engine/thinking)

function transcriptChecks(session: Session | null): { webUrls: string[] } {
  if (!session) {
    record('a', 'Read tool call on PLAN.md', false, ['_evidence/session.json missing']);
    return { webUrls: [] };
  }
  const tools = toolsOf(session.messages);
  const reads = tools.filter((t) => t.name === 'Read' && /PLAN\.md$/i.test(String(t.input.file_path ?? '')));
  const readOk = reads.some((t) => t.status === 'done' && /Orlando Calc/.test(t.result?.content ?? ''));
  record('a', 'Read tool call on PLAN.md (file reading on the user\'s PC)', readOk, [
    ...reads.map((t) => `Read ${String(t.input.file_path)} → ${t.status}, ${(t.result?.content ?? '').length} chars returned, starts "${(t.result?.content ?? '').replace(/\s+/g, ' ').slice(0, 70)}…"`),
    'screenshot _evidence/30-card-read-plan.png',
  ]);
  const web = tools.filter((t) => t.name === 'WebSearch' || t.name === 'WebFetch' || t.name.startsWith('mcp__obsidian__web'));
  const webUrls = web.filter((t) => t.name === 'WebFetch').map((t) => String(t.input.url ?? ''));
  (globalThis as unknown as { __web: string[] }).__web = web.map((t) => `${t.name} ${JSON.stringify(t.input).slice(0, 160)} → ${t.status}${t.status !== 'done' ? '' : `, ${(t.result?.content ?? '').length} chars`}`);
  return { webUrls };
}

// ── b (index.html), e (Chromium)

const BANNER = /Orlando,\s*FL\s*[—–-]+\s*(-?\d+(?:\.\d+)?)\s*°\s*F\s*,\s*([^(\n]+?)\s*\(as of ([^)\n]+)\)/;

async function clickKey(page: Page, variants: string[]): Promise<string> {
  for (const v of variants) {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const loc = page.locator('button').filter({ hasText: new RegExp(`^\\s*${esc}\\s*$`) });
    if (await loc.count()) {
      await loc.first().click();
      return v;
    }
  }
  for (const v of variants) {
    const loc = page.locator(`button[data-key="${v}"], button[data-value="${v}"], button[data-op="${v}"], button[aria-label="${v}"]`);
    if (await loc.count()) {
      await loc.first().click();
      return v;
    }
  }
  throw new Error(`no button for ${variants.join(' / ')}`);
}

async function readDisplay(page: Page): Promise<string> {
  return page.evaluate(() => {
    const d = (globalThis as unknown as { document: { querySelector(s: string): { value?: string; textContent: string | null; tagName: string } | null } }).document;
    const sels = ['#display', '.display', '[data-testid=display]', '#result', '.result', 'output', '#screen', '.screen', '[id*=display]', '[class*=display]', 'input[readonly]'];
    for (const s of sels) {
      const el = d.querySelector(s);
      if (!el) continue;
      const v = el.tagName === 'INPUT' ? (el.value ?? '') : (el.textContent ?? '');
      return `${s}=${v.trim()}`;
    }
    return 'no display element found';
  });
}

async function uiChecks(): Promise<{ bannerTempF: number | null; banner: string | null; comment: string | null }> {
  const indexPath = path.join(DIR, 'index.html');
  if (!existsSync(indexPath)) {
    record('e', 'calculator UI in Chromium', false, ['index.html missing']);
    return { bannerTempF: null, banner: null, comment: null };
  }
  const html = readFileSync(indexPath, 'utf8');
  const comments = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1].trim()).filter((c) => /https?:\/\//.test(c));
  const browser = await chromium.launch({ headless: true });
  const ev: string[] = [];
  let banner: string | null = null;
  let bannerTempF: number | null = null;
  let pass = false;
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    const requests: string[] = [];
    page.on('request', (r) => {
      if (!r.url().startsWith('file:') && !r.url().startsWith('data:')) requests.push(r.url());
    });
    await page.goto(pathToFileURL(indexPath).href);
    await page.waitForTimeout(800);
    const text = await page.innerText('body');
    const m = BANNER.exec(text);
    banner = m ? m[0] : null;
    bannerTempF = m ? Number(m[1]) : null;
    await page.screenshot({ path: path.join(EV, 'calculator.png'), fullPage: true });
    ev.push('screenshot _evidence/calculator.png');
    const title = await page.title();
    ev.push(`page title "${title}"; banner "${banner ?? '(not found)'}"`);

    const clear = ['C', 'AC', 'Clear'];
    await clickKey(page, clear).catch(() => undefined);
    for (const k of [['2'], ['+'], ['3'], ['×', '*', 'x', 'X'], ['4'], ['=']]) await clickKey(page, k);
    await page.waitForTimeout(300);
    const r1 = await readDisplay(page);
    await page.screenshot({ path: path.join(EV, 'calculator-2+3x4.png') });
    await clickKey(page, clear).catch(() => undefined);
    for (const k of [['1'], ['÷', '/'], ['0'], ['=']]) await clickKey(page, k);
    await page.waitForTimeout(300);
    const r2 = await readDisplay(page);
    await page.screenshot({ path: path.join(EV, 'calculator-1div0.png') });
    const v1 = r1.split('=').slice(1).join('=');
    const v2 = r2.split('=').slice(1).join('=');
    pass = v1 === '20' && /^error$/i.test(v2);
    ev.push(`clicked 2 + 3 × 4 = → display ${r1} (expected 20)`, `clicked 1 ÷ 0 = → display ${r2} (expected Error)`, 'screenshots _evidence/calculator-2+3x4.png, _evidence/calculator-1div0.png');
    ev.push(`console errors: ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}; network requests at runtime: ${requests.length ? requests.join(', ') : 'none'}`);
    (globalThis as unknown as { __runtimeRequests: string[] }).__runtimeRequests = requests;
  } catch (e) {
    ev.push(`error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await browser.close();
  }
  record('e', 'Chromium: calculator renders, 2 + 3 × 4 = 20, 1 ÷ 0 = Error', pass, ev);
  return { bannerTempF, banner, comment: comments[0] ?? null };
}

// ── d

function testChecks(): void {
  const t = spawnSync(process.execPath, ['--test'], { cwd: DIR, encoding: 'utf8', timeout: 120_000 });
  const out = `${t.stdout ?? ''}${t.stderr ?? ''}`;
  writeFileSync(path.join(EV, 'node-test-output.txt'), `$ node --test   (cwd ${DIR}, node ${process.version}, exit ${t.status})\n\n${out}`);
  const num = (k: string) => Number(new RegExp(`(?:^|\\n)\\s*(?:#|ℹ)\\s*${k}\\s+(\\d+)`).exec(out)?.[1] ?? NaN);
  const tests = num('tests');
  const pass = num('pass');
  const fail = num('fail');
  const r = spawnSync(process.execPath, ['-e', "const c=require('./calc.js');console.log(JSON.stringify(Object.keys(c)))"], { cwd: DIR, encoding: 'utf8', timeout: 30_000 });
  const ok = t.status === 0 && tests >= 12 && pass === tests && fail === 0 && r.status === 0;
  record('d', 'node --test: >= 12 tests, all pass; require(\'./calc.js\') works', ok, [
    `node --test → exit ${t.status}: tests ${tests}, pass ${pass}, fail ${fail} (full output _evidence/node-test-output.txt)`,
    `node -e "require('./calc.js')" → exit ${r.status}, exports ${(r.stdout ?? '').trim() || (r.stderr ?? '').trim().slice(0, 200)}`,
  ]);
}

// ── f (network)

function inCidr4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const toInt = (a: string) => a.split('.').reduce((s, x) => (s << 8) + Number(x), 0) >>> 0;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

async function netChecks(webFetchUrls: string[]): Promise<{ ok: boolean; lines: string[] }> {
  const file = path.join(EV, 'net-audit.jsonl');
  if (!existsSync(file)) return { ok: false, lines: ['_evidence/net-audit.jsonl missing'] };
  const rows = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\uFEFF/, '').trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => !!x);
  const summary = rows.find((r) => r.summary);
  const endpoints = rows.filter((r) => !r.summary && !r.loopback);
  const anthropicHosts = ['api.anthropic.com', 'claude.ai', 'console.anthropic.com', 'statsig.anthropic.com', 'anthropic.com', 'claude.com', 'mcp-proxy.anthropic.com', 'downloads.claude.ai'];
  const anthropicIps = new Set<string>();
  for (const h of anthropicHosts) {
    for (const fam of ['resolve4', 'resolve6'] as const) {
      try {
        for (const ip of await dns[fam](h)) anthropicIps.add(ip);
      } catch {
        /* no record */
      }
    }
  }
  const known: Record<string, string[]> = {};
  const fetchHosts = [...new Set(webFetchUrls.map((u) => { try { return new URL(u).hostname; } catch { return ''; } }).filter(Boolean))];
  for (const h of ['console.vast.ai', 'cloud.vast.ai', 'html.duckduckgo.com', 'duckduckgo.com', 'api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', ...fetchHosts]) {
    try {
      known[h] = await dns.resolve4(h);
    } catch {
      known[h] = [];
    }
  }
  const lines: string[] = [];
  const analysis: Record<string, unknown>[] = [];
  let anthropicHits = 0;
  for (const e of endpoints) {
    const ip = String(e.remote);
    let rdns: string[] = [];
    try {
      rdns = await dns.reverse(ip);
    } catch {
      rdns = [];
    }
    const knownAs = Object.entries(known).filter(([, ips]) => ips.includes(ip)).map(([h]) => h);
    const isAnthropic = anthropicIps.has(ip) || (net.isIPv4(ip) && inCidr4(ip, '160.79.104.0/21')) || /^2607:6bc0:/i.test(ip) || rdns.some((n) => /anthropic|claude\.ai|claude\.com/i.test(n));
    if (isAnthropic) anthropicHits++;
    const proc = `${String(e.process)}${/--type=utility/.test(String(e.cmd)) ? ' (network service)' : /claude/i.test(String(e.process)) ? '' : String(e.cmd).includes('--type=') ? '' : ' (main/core)'}`;
    const port = Number(e.port);
    const role = isAnthropic
      ? 'ANTHROPIC'
      : knownAs.some((h) => h.includes('vast'))
        ? 'Vast API'
        : port !== 443 && port !== 80 && /main\/core/.test(proc)
          ? 'Vast instance SSH (the model tunnel)'
          : knownAs.length
            ? knownAs.join('/')
            : /claude/i.test(proc) && fetchHosts.length
              ? `a WebFetch target behind a CDN (WebFetch hosts: ${fetchHosts.join(', ')})`
              : rdns.join(',') || 'unresolved';
    analysis.push({ process: proc, ip, port, rdns, knownAs, role, samples: e.count, firstSeenSec: e.t });
    lines.push(`${proc} → ${ip}:${port} [${role}]${rdns.length ? ` rdns ${rdns.join(',')}` : ''} (${e.count} samples)`);
  }
  writeFileSync(path.join(EV, 'net-audit-analysis.json'), JSON.stringify({ anthropicIpsChecked: [...anthropicIps], cidrsChecked: ['160.79.104.0/21', '2607:6bc0::/32'], endpoints: analysis, loopback: summary?.loopbackPeers ?? null, processesSeen: summary?.processesSeen ?? null, seconds: summary?.seconds ?? null }, null, 2));
  lines.unshift(`${endpoints.length} remote endpoint(s) over ${summary?.seconds ?? '?'} s of sampling; Anthropic/claude.ai endpoints: ${anthropicHits}`);
  if (summary?.loopbackPeers) lines.push(`loopback: ${(summary.loopbackPeers as string[]).join(' | ')}`);
  return { ok: anthropicHits === 0 && !!summary, lines };
}

async function main(): Promise<void> {
  console.log(`final checks for ${DIR}\n`);
  const session = readJson<Session>(path.join(EV, 'session.json'));
  const summary = readJson<Record<string, unknown>>(path.join(EV, 'run-summary.json'));
  const driver = readJson<Record<string, unknown>>(path.join(EV, 'driver-result.json'));
  const weather = readJson<{ tag: string; at: string; wttr?: { tempF?: number; conditions?: string }; nws?: { tempF?: number | null; conditions?: string } }[]>(path.join(EV, 'weather-reference.json')) ?? [];

  const { webUrls } = transcriptChecks(session);

  // c — files
  const present = FILES.filter((f) => existsSync(path.join(DIR, f)));
  record('c', 'all six files exist', present.length === FILES.length, [
    `present: ${present.map((f) => `${f} (${readFileSync(path.join(DIR, f)).length} B)`).join(', ')}`,
    `missing: ${FILES.filter((f) => !present.includes(f)).join(', ') || 'none'}`,
    `folder: ${readdirSync(DIR).join(', ')}`,
  ]);

  testChecks();
  const ui = await uiChecks();

  // b — web + banner + comment + comparison
  const web = (globalThis as unknown as { __web?: string[] }).__web ?? [];
  const runtimeReq = (globalThis as unknown as { __runtimeRequests?: string[] }).__runtimeRequests ?? [];
  const sources = [...new Set([...readFileSync(path.join(DIR, 'index.html'), 'utf8').matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]))];
  const readings = weather.flatMap((w) => [
    ...(typeof w.wttr?.tempF === 'number' ? [{ src: `wttr.in @ ${w.at} (${w.tag})`, f: w.wttr.tempF, c: w.wttr.conditions }] : []),
    ...(typeof w.nws?.tempF === 'number' ? [{ src: `api.weather.gov KMCO @ ${w.at} (${w.tag})`, f: w.nws.tempF as number, c: w.nws.conditions }] : []),
  ]);
  const close = ui.bannerTempF === null ? [] : readings.filter((r) => Math.abs(r.f - (ui.bannerTempF as number)) <= 8);
  const webOk = web.some((w) => /→ done/.test(w));
  const bOk = webOk && ui.banner !== null && ui.comment !== null && close.length > 0 && runtimeReq.length === 0;
  record('b', 'web search tool calls + hard-coded weather line + source comment + temperature within ±8°F', bOk, [
    ...web.map((w) => `tool: ${w}`),
    `banner line: ${ui.banner ?? '(not found)'}`,
    `HTML comment: ${ui.comment ? ui.comment.replace(/\s+/g, ' ').slice(0, 220) : '(none with a URL)'}`,
    `URLs in index.html: ${sources.join(', ') || 'none'}; WebFetch URLs: ${webUrls.join(', ') || 'none'}`,
    `independent readings during the run: ${readings.map((r) => `${r.f}°F ${r.c ?? ''} [${r.src}]`).join('; ') || 'none'}`,
    `model ${ui.bannerTempF ?? '?'}°F vs readings: ${close.length ? `within ±8°F of ${close.map((r) => `${r.f}°F`).join(', ')}` : 'NOT within ±8°F'}`,
    `runtime network requests from the page: ${runtimeReq.length ? runtimeReq.join(', ') : 'none (hard-coded)'}`,
  ]);

  // f — harness look + network
  const thinkingBlocks = session ? session.messages.flatMap((m) => m.blocks.filter((b) => b.type === 'thinking')).length : 0;
  const tools = session ? toolsOf(session.messages) : [];
  const names = [...new Set(tools.map((t) => t.name))];
  const shots = existsSync(EV) ? readdirSync(EV).filter((f) => /^\d\d-.*\.png$/.test(f)) : [];
  const netr = await netChecks(webUrls);
  const fOk = session?.engine === 'claude-code' && thinkingBlocks > 0 && names.includes('TodoWrite') && shots.some((s) => s.startsWith('20-thinking')) && shots.some((s) => s.startsWith('36-card-todos')) && netr.ok;
  record('f', 'Claude Code harness look; model calls only to the Vast endpoint (no Anthropic traffic)', fOk, [
    `session engine ${session?.engine}, permission mode ${session?.permissionMode}, thinking ${session?.thinking}, model ${session?.model ? `${session.model.provider}:${session.model.model}` : '?'}`,
    `${session?.messages.filter((m) => m.role === 'assistant').length ?? 0} assistant messages, ${thinkingBlocks} thinking blocks, ${tools.length} tool calls: ${names.join(', ')}`,
    `screenshots: ${shots.join(', ')}`,
    ...netr.lines.map((l) => `net: ${l}`),
  ]);

  // g — clock-out
  const fin = (driver?.final ?? {}) as { clockOut?: { ok: boolean; detail: string } };
  const gOk = !!fin.clockOut?.ok && /phase=off orphanInstanceIds=\[\] ledger\.active=null/.test(String(driver?.finalState ?? '')) && driver?.ok !== undefined;
  record('g', 'clock-out verified, nothing left on Vast', gOk, [
    `after the turn: ${fin.clockOut?.detail ?? '?'}`,
    `end of run: ${String(driver?.finalState ?? '?')}`,
    `run record: ${JSON.stringify(driver?.runRecord ?? null)}`,
  ]);

  const outFile = path.join(EV, 'checks.json');
  writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), dir: DIR, runId: summary?.runId ?? null, checks }, null, 2));
  const all = checks.every((c) => c.pass);
  console.log(`\n${all ? 'ALL PASS' : 'SOME CHECKS FAILED'} → ${outFile}`);
  process.exitCode = all ? 0 : 1;
}

void main();
