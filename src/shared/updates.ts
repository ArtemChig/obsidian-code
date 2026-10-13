// Auto-update state shared by the main process (src/main/updater.ts) and the renderer (window.obsidian.updates).
// The token used to read the private GitHub repo never crosses this boundary: only where it came from.

/** Where the GitHub token for update checks came from (never the token itself). */
export type UpdateTokenSource =
  /** Settings → About & updates (secret 'github.updateToken'). */
  | 'secret'
  /** `gh auth token` (the GitHub CLI login on this PC). */
  | 'gh'
  /** Neither: checks against the private repo cannot work. */
  | 'none'
  /** Test feed (OBSIDIAN_UPDATE_TEST_FEED): no token needed. */
  | 'not-needed';

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; releaseNotes: string | null; releaseDate: string | null }
  | { status: 'not-available'; checkedAt: number }
  | { status: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { status: 'downloaded'; version: string }
  /** Graceful quit (session flush, GPU clock-out per settings) then the installer runs and the app restarts. */
  | { status: 'installing'; version: string }
  | { status: 'error'; message: string; during: 'check' | 'download' | 'install' }
  /** Updates cannot work in this build (dev run, unpacked folder, portable exe). */
  | { status: 'unsupported'; reason: string };

export type UpdateStatus = UpdateState['status'];

export interface UpdateSnapshot {
  state: UpdateState;
  /** The running app's version (package.json "version"). */
  currentVersion: string;
  /** Epoch ms of the last finished check (success or failure), null before the first one. */
  lastCheckedAt: number | null;
  /** Null until the first check resolved a token. */
  tokenSource: UpdateTokenSource | null;
  /** Why no token was found ("GitHub CLI not found", "gh is not signed in"…), when tokenSource is 'none'. */
  tokenNote: string | null;
  /** The newest release seen (available / downloading / downloaded / installing), for "View on GitHub". */
  releaseUrl: string | null;
}

export const UPDATE_REPO = { owner: 'ArtemChig', repo: 'obsidian-code' } as const;
export const UPDATE_TOKEN_SECRET = 'github.updateToken';

export function releaseUrlFor(version: string): string {
  return `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/tag/v${version}`;
}

/** The version an in-flight or offered update is about, if any. */
export function updateVersion(state: UpdateState): string | null {
  switch (state.status) {
    case 'available':
    case 'downloading':
    case 'downloaded':
    case 'installing':
      return state.version;
    default:
      return null;
  }
}
