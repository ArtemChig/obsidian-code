// Tiny stdio MCP server used by the extensions tests (built on @modelcontextprotocol/sdk).
//
// Always exposes two tools: `echo` and `add`.
// With FIXTURE_EXTRA=1 it also exposes: `sleep`, `image`, `resource`, `add_tool` (registers `dynamic` at runtime so the
// server emits notifications/tools/list_changed).
// FIXTURE_PIDFILE=<path> makes it write its pid there on startup (tests use it to verify the process is cleaned up).

import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

if (process.env.FIXTURE_PIDFILE) writeFileSync(process.env.FIXTURE_PIDFILE, String(process.pid));

const server = new McpServer({ name: 'fixture', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echo the given text back. Set fail=true to get an error result instead.',
    inputSchema: { text: z.string().describe('Text to echo'), fail: z.boolean().optional() },
  },
  async ({ text, fail }) =>
    fail
      ? { content: [{ type: 'text', text: `failed: ${text}` }], isError: true }
      : { content: [{ type: 'text', text: `echo: ${text}` }] },
);

server.registerTool(
  'add',
  {
    description: 'Add two numbers and return the sum.',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);

if (process.env.FIXTURE_EXTRA === '1') {
  server.registerTool(
    'sleep',
    { description: 'Sleep for ms milliseconds.', inputSchema: { ms: z.number() } },
    async ({ ms }) => {
      await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: 'text', text: `slept ${ms}` }] };
    },
  );

  server.registerTool('image', { description: 'Return a 1x1 PNG.' }, async () => ({
    content: [
      { type: 'text', text: 'here is the image' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    ],
  }));

  server.registerTool('resource', { description: 'Return an embedded text resource and a link.' }, async () => ({
    content: [
      { type: 'resource', resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'resource body' } },
      { type: 'resource_link', uri: 'file:///other.txt', name: 'other' },
    ],
  }));

  server.registerTool('add_tool', { description: 'Register a new tool called `dynamic` at runtime.' }, async () => {
    server.registerTool('dynamic', { description: 'Registered at runtime.' }, async () => ({
      content: [{ type: 'text', text: 'dynamic ok' }],
    }));
    return { content: [{ type: 'text', text: 'registered' }] };
  });
}

await server.connect(new StdioServerTransport());
