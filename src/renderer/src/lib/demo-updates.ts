// Simulated updater for demo mode (owner: ui-foundation), so the update UI can be reviewed and screenshotted in the
// browser. Pick a starting state with ?update=…:
//   (none) up to date · available · downloading · installing · error (no GitHub access) · failed (download failed)
//   portable (unsupported) · secret (available, saved-token source)
// check() finds 0.1.1; update() walks downloading → downloaded → installing → "restarted" into the new version.
import type { UpdateSnapshot, UpdateState } from '@shared/updates';
import { releaseUrlFor } from '@shared/updates';
import { toast } from '@renderer/state/toasts';
import type { UpdatesApi } from '@renderer/state/updates';

const CURRENT = '0.1.0';
const NEXT = '0.1.1';
const NOTES = `### Fixes
- Vast.ai: request \`target_state: running\` on create and fail fast if the instance stays stopped.
- Month spend no longer double-counts the current session.

### Improvements
- **One-click updates**: an UPDATE button appears in the menu strip when a new version is out.`;

function available(): UpdateState {
  return { status: 'available', version: NEXT, releaseNotes: NOTES, releaseDate: new Date(Date.now() - 3 * 3600_000).toISOString() };
}

function initial(scenario: string | null): UpdateSnapshot {
  const now = Date.now();
  const base: UpdateSnapshot = {
    state: { status: 'not-available', checkedAt: now - 2 * 60_000 },
    currentVersion: CURRENT,
    lastCheckedAt: now - 2 * 60_000,
    tokenSource: 'gh',
    tokenNote: null,
    releaseUrl: null,
  };
  switch (scenario) {
    case 'available':
      return { ...base, state: available(), releaseUrl: releaseUrlFor(NEXT) };
    case 'secret':
      return { ...base, state: available(), tokenSource: 'secret', releaseUrl: releaseUrlFor(NEXT) };
    case 'downloading':
      return { ...base, state: { status: 'downloading', version: NEXT, percent: 42, bytesPerSecond: 6.2e6 }, releaseUrl: releaseUrlFor(NEXT) };
    case 'installing':
      return { ...base, state: { status: 'installing', version: NEXT }, releaseUrl: releaseUrlFor(NEXT) };
    case 'error':
      return {
        ...base,
        state: {
          status: 'error',
          during: 'check',
          message: 'No GitHub access for update checks. Sign in with the GitHub CLI (gh auth login) or save a read-only token in Settings → About & updates.',
        },
        tokenSource: 'none',
        tokenNote: 'GitHub CLI is not signed in (run gh auth login)',
      };
    case 'failed':
      return { ...base, state: { status: 'error', during: 'download', message: 'Could not reach the update server (offline?). It will try again later.' } };
    case 'portable':
      return { ...base, state: { status: 'unsupported', reason: 'portable build — use the installer to get automatic updates' }, tokenSource: null, lastCheckedAt: null };
    default:
      return base;
  }
}

export function createDemoUpdates(scenario: string | null): UpdatesApi {
  let snap = initial(scenario);
  const listeners = new Set<(s: UpdateSnapshot) => void>();
  const set = (patch: Partial<UpdateSnapshot>): UpdateSnapshot => {
    snap = { ...snap, ...patch };
    for (const l of listeners) l(snap);
    return snap;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let running = false;

  const check = async (): Promise<UpdateSnapshot> => {
    if (snap.state.status === 'unsupported' || running) return snap;
    set({ state: { status: 'checking' } });
    await sleep(900);
    if (scenario === 'error') return set({ state: initial('error').state, lastCheckedAt: Date.now() });
    if (snap.currentVersion === NEXT) return set({ state: { status: 'not-available', checkedAt: Date.now() }, lastCheckedAt: Date.now(), releaseUrl: null });
    return set({ state: available(), lastCheckedAt: Date.now(), releaseUrl: releaseUrlFor(NEXT) });
  };

  const update = async (): Promise<UpdateSnapshot> => {
    if (running || snap.state.status === 'unsupported') return snap;
    running = true;
    void (async () => {
      try {
        const status = (): UpdateState['status'] => snap.state.status;
        if (status() !== 'available' && status() !== 'downloading') {
          running = false;
          await check();
          running = true;
          if (status() !== 'available') return;
        }
        const start = snap.state.status === 'downloading' ? snap.state.percent : 0;
        for (let p = start; p <= 100; p += 4) {
          set({ state: { status: 'downloading', version: NEXT, percent: p, bytesPerSecond: 5.8e6 + Math.random() * 1e6 } });
          await sleep(110);
        }
        set({ state: { status: 'downloaded', version: NEXT } });
        await sleep(300);
        set({ state: { status: 'installing', version: NEXT } });
        await sleep(1600);
        // "Restarted" into the new version.
        set({ currentVersion: NEXT, state: { status: 'not-available', checkedAt: Date.now() }, lastCheckedAt: Date.now(), releaseUrl: null });
        toast({ title: `Updated to ${NEXT}`, body: 'Demo mode: the app would restart into the new version here.', level: 'success' });
      } finally {
        running = false;
      }
    })();
    return snap;
  };

  return {
    getState: async () => snap,
    check,
    update,
    onState(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
