// HTTP 서버 한 프로세스: /mcp(Streamable HTTP, 세션·SSE), /api/agent, 데모 제어, 시뮬레이터 정적 파일을 함께 제공한다
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localhostHostValidation, localhostOriginValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, type McpServer } from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { ALERTS_URI, buildMcpServer } from './mcp.js';
import { buildSimulatorScript, buildUiViews, type UiView } from './ui-bundle.js';
import { calendarIcs } from './ics.js';

interface Session {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  subscriptions: Set<string>;
}

export interface AgentHandler {
  (body: { text?: string; conversationId?: string }): Promise<unknown>;
}

export interface AppServer {
  http: Server;
  url: string;
  ui: Record<UiView['key'], UiView>;
  sessions: Map<string, Session>;
  close(): Promise<void>;
}

const SIM_DIR = join(import.meta.dirname, '..', 'sim');

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export async function startServer(ctx: AppContext, opts: { agent: AgentHandler; port?: number }): Promise<AppServer> {
  const ui = await buildUiViews();
  const simJs = await buildSimulatorScript();
  const sessions = new Map<string, Session>();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  // Proactive alerts: tell every session that subscribed to home://alerts.
  const notifyAlerts = () => {
    for (const s of sessions.values()) {
      if (s.subscriptions.has(ALERTS_URI)) void s.server.server.sendResourceUpdated({ uri: ALERTS_URI }).catch(() => {});
    }
  };
  ctx.alertListeners.add(notifyAlerts);

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const existing = sid ? sessions.get(sid) : undefined;
    if (existing) return existing.transport.handleRequest(req, res, req.method === 'POST' ? await readJson(req) : undefined);
    if (req.method !== 'POST') return send(res, sid ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sid ? 'Session not found' : 'Missing session' }, id: null });
    const body = await readJson(req);
    if (sid || !isInitializeRequest(body)) {
      return send(res, sid ? 404 : 400, { jsonrpc: '2.0', error: { code: -32000, message: sid ? 'Session not found' : 'Bad Request: initialize first' }, id: null });
    }
    const subscriptions = new Set<string>();
    const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, subscriptions });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const server = buildMcpServer(ctx, ui, {
      onSubscribe: (uri) => subscriptions.add(uri),
      onUnsubscribe: (uri) => subscriptions.delete(uri),
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  const http = createServer(async (req, res) => {
    try {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/mcp') return await handleMcp(req, res);

      if (path === '/api/agent' && req.method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, await opts.agent(body));
      }
      if (path === '/api/calendar.ics') return send(res, 200, calendarIcs(ctx.service.household()), 'text/calendar; charset=utf-8');
      if (path === '/api/health') return send(res, 200, { ok: true, recalls: ctx.index.size, demo: ctx.config.demo, now: ctx.clock.now().toISOString() });

      if (path.startsWith('/api/demo/')) {
        if (!ctx.config.demo) return send(res, 404, { error: 'demo mode is off (set HOME_AHEAD_DEMO=1)' });
        if (path === '/api/demo/reset' && req.method === 'POST') {
          ctx.resetDemo();
          return send(res, 200, { now: ctx.clock.now().toISOString() });
        }
        if (path === '/api/demo/advance' && req.method === 'POST') {
          const { days = 1 } = await readJson(req);
          ctx.clock.advanceDays(Number(days));
          const swept = ctx.service.sweep(true);
          return send(res, 200, { now: ctx.clock.now().toISOString(), newAlerts: swept.alerts.length });
        }
        return send(res, 404, { error: 'unknown demo endpoint' });
      }

      if (path === '/' || path === '/index.html') return send(res, 200, readFileSync(join(SIM_DIR, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      if (path === '/sim.css') return send(res, 200, readFileSync(join(SIM_DIR, 'sim.css'), 'utf8'), 'text/css; charset=utf-8');
      if (path === '/sim.js') return send(res, 200, simJs, 'text/javascript; charset=utf-8');
      if (path === '/demo-script.json') return send(res, 200, readFileSync(join(import.meta.dirname, '..', '..', 'video', 'script.json'), 'utf8'));
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      console.error('[http]', err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  await new Promise<void>((resolve) => http.listen(opts.port ?? ctx.config.port, ctx.config.host, resolve));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : ctx.config.port;
  const base = `http://${ctx.config.host}:${port}`;

  return {
    http,
    url: base,
    ui,
    sessions,
    async close() {
      ctx.alertListeners.delete(notifyAlerts);
      for (const s of sessions.values()) await s.transport.close().catch(() => {});
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
