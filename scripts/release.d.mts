// Types for the pure helpers exported by scripts/release.mjs (used by tests/unit/platform/release.test.ts).
export declare const REPO: string;
export declare const CHANGELOG_HEADER: string;
export type Bump = 'patch' | 'minor' | 'major';
export declare function parseArgs(argv: string[]): { bump: Bump | null; set: string | null; notes: string | null; dryRun: boolean; error: string | null };
export declare function isVersion(v: unknown): boolean;
export declare function compareVersions(a: string, b: string): -1 | 0 | 1;
export declare function nextVersion(current: string, opts?: { bump?: Bump | null; set?: string | null }): string;
export declare function setPackageVersion(text: string, version: string): string;
export declare function setLockVersion(text: string, version: string): string;
export declare function today(d?: Date): string;
export declare function notesFromCommits(subjects: string[]): string;
export declare function changelogEntry(e: { version: string; date: string; notes: string }): string;
export declare function prependChangelog(existing: string | null | undefined, entry: string): string;
export declare function checkReleaseAssets(
  assets: ({ name: string } | string)[] | null | undefined,
  version: string,
): { setup: string | null; blockmap: string | null; latestYml: string | null; missing: string[] };
export declare function planSteps(o: { current: string; version: string; branch?: string }): string[];
