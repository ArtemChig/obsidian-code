// Where skills / agents / commands live. Roots are returned in INCREASING precedence (later entries override earlier
// ones on a name clash): ~/.claude < ~/.obsidian-code < <cwd>/.claude < <cwd>/.obsidian-code.

import path from 'node:path';

export interface ConfigRoot {
  dir: string;
  level: 'user' | 'project';
  /** True for the Claude Code compatible roots (.claude), only used when settings.importClaudeConfig is on. */
  claude: boolean;
}

export function configRoots(home: string, cwd: string, importClaudeConfig: boolean): ConfigRoot[] {
  const roots: ConfigRoot[] = [];
  const project = path.resolve(cwd);
  if (importClaudeConfig) roots.push({ dir: path.join(home, '.claude'), level: 'user', claude: true });
  roots.push({ dir: path.join(home, '.obsidian-code'), level: 'user', claude: false });
  // Avoid scanning the home config twice when the cwd *is* the home directory.
  const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(project, path.resolve(home))) {
    if (importClaudeConfig) roots.push({ dir: path.join(project, '.claude'), level: 'project', claude: true });
    roots.push({ dir: path.join(project, '.obsidian-code'), level: 'project', claude: false });
  }
  return roots;
}
