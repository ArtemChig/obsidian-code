import { defineTool, fail, ok } from './types';

type SkillInput = { skill: string; args?: string };

export const skillTool = defineTool<SkillInput>(
  {
    name: 'Skill',
    description: 'Load a skill (specialised instructions) by name from the list in the system prompt, then follow it. Returns its text and base directory (resolve relative file references against it).',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name' },
        args: { type: 'string', description: 'Optional arguments' },
      },
      required: ['skill'],
    },
    concurrencySafe: true,
    permission: () => 'none',
    title: (i) => `Skill: ${i.skill ?? ''}`.trim(),
    ruleFor: () => 'Skill',

    async run(input, ctx) {
      const name = input.skill.trim().replace(/^\//, '');
      const skill = await ctx.ext.loadSkill(ctx.cwd, name);
      if (!skill) {
        let names = '';
        try {
          names = (await ctx.ext.skills(ctx.cwd)).map((s) => s.name).join(', ');
        } catch { /* optional */ }
        return fail(`Unknown skill "${name}".${names ? ` Available skills: ${names}.` : ' No skills are installed.'}`);
      }
      let body = skill.body;
      if (input.args?.trim()) {
        body = body.includes('$ARGUMENTS') ? body.split('$ARGUMENTS').join(input.args.trim()) : `${body}\n\nARGUMENTS: ${input.args.trim()}`;
      }
      return ok(`Loaded skill "${skill.name}".\nBase directory for this skill: ${skill.dir.replace(/\\/g, '/')}\n\n${body}`, {
        display: { kind: 'markdown', markdown: `Loaded skill **${skill.name}**` },
      });
    },
  },
  { aliases: { skill: ['name', 'skill_name', 'command'], args: ['arguments', 'argument'] } },
);
