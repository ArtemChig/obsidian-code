// In-process HTTP MCP fixture for tests: a streamable-HTTP server (POST /mcp) or a legacy SSE server (GET /sse +
// POST /messages). Both expose one tool, `whoami`, which reports the Authorization header it saw.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface HttpFixture {
  /** Streamable endpoint (mode 'streamable') or SSE endpoint (mode 'sse'). */
  url: string;
  /** Number of MCP requests that were rejected because the required header was missing. */
  rejected(): number;
  close(): Promise<void>;
}

function makeServer(authHeader: string | undefined): McpServer {
  const server = new McpServer({ name: 'http-fixture', version: '1.0.0' });
  server.registerTool('whoami', { description: 'Report the Authorization header the server saw.' }, async () => ({
    content: [{ type: 'text', text: `auth=${authHeader ?? 'none'}` }],
  }));
  return server;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export async function startHttpFixture(opts: { mode: 'streamable' | 'sse'; requireAuth?: string }): Promise<HttpFixture> {
  let rejected = 0;
  const sse = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const auth = req.headers.authorization;
      if (opts.requireAuth && auth !== opts.requireAuth) {
        rejected++;
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
        return;
      }
      try {
        if (opts.mode === 'streamable') {
          if (url.pathname !== '/mcp') return void res.writeHead(404).end();
          const body = req.method === 'POST' ? await readBody(req) : undefined;
          const server = makeServer(auth);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            void transport.close();
            void server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        // legacy SSE
        if (url.pathname === '/sse' && req.method === 'GET') {
          const transport = new SSEServerTransport('/messages', res);
          sse.set(transport.sessionId, transport);
          res.on('close', () => sse.delete(transport.sessionId));
          await makeServer(auth).connect(transport);
          return;
        }
        if (url.pathname === '/messages' && req.method === 'POST') {
          const t = sse.get(url.searchParams.get('sessionId') ?? '');
          if (!t) return void res.writeHead(404).end('no session');
          await t.handlePostMessage(req, res, await readBody(req));
          return;
        }
        // POST /sse (streamable attempt) → 405 so the client falls back to the SSE transport
        res.writeHead(405, { allow: 'GET' }).end('method not allowed');
      } catch (e) {
        if (!res.headersSent) res.writeHead(500).end(String((e as Error).message));
      }
    })();
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${opts.mode === 'streamable' ? '/mcp' : '/sse'}`,
    rejected: () => rejected,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
