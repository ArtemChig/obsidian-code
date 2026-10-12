// Skills: <root>/skills/<name>/SKILL.md with YAML frontmatter (name, description). Body is returned on demand.

import path from 'node:path';
import type { SkillInfo } from '../../shared/types';
import { firstLine, fmString, parseMarkdown } from './frontmatter';
import { configRoots } from './roots';
import { FileCache, isDirectory, readDirSafe, truncate } from './util';

interface SkillRecord {
  info: SkillInfo;
  body: string;
  dir: string;
}

interface Parsed {
  name?: string;
  description: string;
  body: string;
}

export interface SkillsDeps {
  home: string;
  importClaudeConfig: () => boolean;
}

export function createSkillsIndex(deps: SkillsDeps) {
  const cache = new FileCache<Parsed>();

  async function scan(cwd: string): Promise<SkillRecord[]> {
    const byName = new Map<string, SkillRecord>();
    for (const root of configRoots(deps.home, cwd, deps.importClaudeConfig())) {
      const skillsDir = path.join(root.dir, 'skills');
      const source: SkillInfo['source'] = root.claude ? (root.level === 'user' ? 'claude-user' : 'claude-project') : root.level;
      const entries = await readDirSafe(skillsDir);
      for (const entry of entries) {
        if (entry.name.startsWith('.') || !(await isDirectory(entry, skillsDir))) continue;
        const dir = path.join(skillsDir, entry.name);
        const file = path.join(dir, 'SKILL.md');
        const parsed = await cache.get(file, (raw) => {
          const { data, body } = parseMarkdown(raw);
          return { name: fmString(data.name), description: fmString(data.description) ?? firstLine(body), body: body.trim() };
        });
        if (!parsed) continue;
        const name = parsed.name ?? entry.name;
        byName.set(name.toLowerCase(), {
          info: { name, description: truncate(parsed.description.replace(/\s+/g, ' '), 400), path: file, source },
          body: parsed.body,
          dir,
        });
      }
    }
    return [...byName.values()].sort((a, b) => a.info.name.localeCompare(b.info.name));
  }

  async function skills(cwd: string): Promise<SkillInfo[]> {
    return (await scan(cwd)).map((r) => r.info);
  }

  async function loadSkill(cwd: string, name: string): Promise<{ name: string; body: string; dir: string } | null> {
    const want = name.trim().replace(/^\//, '').toLowerCase();
    if (!want) return null;
    const rec = (await scan(cwd)).find((r) => r.info.name.toLowerCase() === want || path.basename(r.dir).toLowerCase() === want);
    return rec ? { name: rec.info.name, body: rec.body, dir: rec.dir } : null;
  }

  return { skills, loadSkill };
}
