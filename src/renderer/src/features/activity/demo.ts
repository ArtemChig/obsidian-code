// Demo-mode data for the Activity view (loaded automatically with ?demo=1). Owner: ui-views.
import { registerDemoData } from '@renderer/lib/demo';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

registerDemoData((d) => {
  const now = Date.now();
  const has = (id: string) => (d.sessions.some((s) => s.id === id) ? id : undefined);
  return {
    activity: [
      { id: 'a-core', kind: 'shell', title: 'tsx watch src/core/standalone.ts', sessionId: has('s-sse'), status: 'running', startedAt: now - 52 * MIN, detail: 'core listening on ws://127.0.0.1:41873' },
      { id: 'a-glm', kind: 'session', title: 'Fix GLM tool-call parsing', sessionId: has('s-glm'), status: 'done', startedAt: now - 27 * MIN, endedAt: now - 14 * MIN, detail: '3 files changed, 18 tests passing' },
      { id: 'a-plan', kind: 'subagent', title: 'Plan: reconnect strategy', sessionId: has('s-glm'), status: 'done', startedAt: now - 3 * HOUR, endedAt: now - 2.9 * HOUR, detail: 'Returned a 5-step plan' },
      { id: 'a-hearth', kind: 'session', title: 'Hearth: stream TTS in chunks', sessionId: has('s-hearth'), status: 'done', startedAt: now - 5 * HOUR, endedAt: now - 3 * HOUR, detail: 'Sentence-level audio flush' },
      { id: 'a-test-watch', kind: 'shell', title: 'npm test -- --watch', sessionId: has('s-glm'), status: 'stopped', startedAt: now - 7 * HOUR, endedAt: now - 6.8 * HOUR, detail: 'Stopped by you' },
      { id: 'a-bench-run', kind: 'schedule_run', title: 'Weekly benchmark on Vast', status: 'error', startedAt: now - 6 * DAY, endedAt: now - 6 * DAY + 4_000, detail: 'Budget guard: monthly budget would be exceeded' },
    ],
  };
});
