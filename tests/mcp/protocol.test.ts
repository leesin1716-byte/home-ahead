// MCP 프로토콜 통합 테스트: 실제 HTTP 서버를 띄워 초기화·버전 협상·도구·리소스 구독·알림·Origin 검사를 확인한다
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startApp, type RunningApp } from '../../src/app.js';

const ENV = { HOME_AHEAD_DEMO: '1', HOME_AHEAD_OFFLINE: '1', HOME_AHEAD_AGENT: 'planner', PORT: '0' };
let app: RunningApp;
let mcpUrl: string;

beforeAll(async () => {
  app = await startApp(ENV, { port: 0 });
  mcpUrl = `${app.server.url}/mcp`;
});
afterAll(async () => {
  await app?.close();
});

async function rawInitialize(protocolVersion: string, headers: Record<string, string> = {}) {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  });
}

async function readInitResult(res: Response) {
  const text = await res.text();
  const json = text.startsWith('{') ? text : text.split('\n').find((l) => l.startsWith('data:'))!.slice(5);
  return JSON.parse(json);
}

describe('Streamable HTTP transport', () => {
  it('negotiates protocol 2025-11-25 and issues a session id', async () => {
    const res = await rawInitialize('2025-11-25');
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toMatch(/[0-9a-f-]{36}/);
    const body = await readInitResult(res);
    expect(body.result.protocolVersion).toBe('2025-11-25');
    expect(body.result.serverInfo.name).toBe('home-ahead');
    expect(body.result.capabilities.resources.subscribe).toBe(true);
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('answers an unknown future version with a version it supports', async () => {
    const body = await readInitResult(await rawInitialize('2099-01-01'));
    expect(body.result.protocolVersion).toBe('2025-11-25');
  });

  it('rejects requests from a foreign Origin (DNS rebinding guard)', async () => {
    const res = await rawInitialize('2025-11-25', { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('rejects non-initialize requests without a session', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown session id', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('SDK v2 client', () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: 'test-v2', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  });
  afterAll(async () => client.close());

  it('lists nine tools, each with input and output schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['add_items', 'check_recalls', 'check_secondhand_item', 'confirm_supply_order', 'get_recall_guidance', 'get_safety_plan', 'prepare_supply_order', 'set_child_stage', 'update_task'].sort(),
    );
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.outputSchema?.type, t.name).toBe('object');
      expect(t.description!.length, t.name).toBeGreaterThan(20);
    }
  });

  it('links tools to content-hashed MCP Apps UI resources', async () => {
    const { tools } = await client.listTools();
    const uri = (tools.find((t) => t.name === 'get_safety_plan')!._meta as { ui: { resourceUri: string } }).ui.resourceUri;
    expect(uri).toMatch(/^ui:\/\/home-ahead\/safety-plan-[0-9a-f]{8}\.html$/);
    const res = await client.readResource({ uri });
    const c = res.contents[0] as { mimeType: string; text: string };
    expect(c.mimeType).toBe('text/html;profile=mcp-app');
    expect(c.text).toContain('<main id="root">');
    expect(c.text).not.toMatch(/<script[^>]+src=/); // self-contained bundle
  });

  it('calls a tool and returns spoken text plus structured content', async () => {
    const res = await client.callTool({ name: 'check_secondhand_item', arguments: { category: 'high_chair', model: 'TB-HC6900' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { spoken: string; verdict: string; recall: { recallNumber: string } };
    expect(sc.verdict).toBe('do_not_use');
    expect(sc.recall.recallNumber).toBe('26290');
    expect((res.content as { text: string }[])[0].text).toBe(sc.spoken);
  });

  it('returns isError with one speakable sentence for bad input the schema allows', async () => {
    const res = await client.callTool({ name: 'confirm_supply_order', arguments: { token: 'does-not-exist' } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toMatch(/^[^{}]+\.$/);
  });

  it('rejects arguments that break the input schema', async () => {
    const res = await client.callTool({ name: 'set_child_stage', arguments: { birthMonth: '2026-01-15' } }).catch((e: Error) => ({ isError: true, error: e.message }));
    expect(res.isError).toBe(true);
  });

  it('reads the household resource', async () => {
    const res = await client.readResource({ uri: 'home://household' });
    const h = JSON.parse((res.contents[0] as { text: string }).text);
    expect(h.children[0].nickname).toBe('Ava');
    expect(h.simulatedClock).toBe(true);
  });
});

describe('SDK v1 client (the one Strands Agents uses) against the v2 server', () => {
  it('negotiates 2025-11-25, lists tools, calls one, and gets a subscription alert', async () => {
    const client = new V1Client({ name: 'test-v1', version: '1' });
    const transport = new V1Transport(new URL(mcpUrl));
    await client.connect(transport);
    expect(transport.protocolVersion).toBe('2025-11-25');
    expect((await client.listTools()).tools).toHaveLength(9);

    const updated = new Promise<string>((resolve) => client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => resolve(n.params.uri)));
    await client.subscribeResource({ uri: 'home://alerts' });

    // Move the demo clock past the dresser recall's publication date and sweep.
    app.ctx.resetDemo();
    app.ctx.clock.advanceDays(28);
    const swept = app.ctx.service.sweep(true);
    expect(swept.alerts.map((a) => a.recallNumber)).toContain('26794');
    await expect(Promise.race([updated, new Promise((_, rej) => setTimeout(() => rej(new Error('no notification')), 5000))])).resolves.toBe('home://alerts');

    const alerts = JSON.parse(((await client.readResource({ uri: 'home://alerts' })).contents[0] as { text: string }).text);
    expect(alerts.unread.map((a: { recallNumber?: string }) => a.recallNumber)).toContain('26794');
    await client.close();
  });
});

async function initSession(url = mcpUrl): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  });
  await res.text();
  return res.headers.get('mcp-session-id')!;
}

function listTools(sid: string, url = mcpUrl) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
}

describe('transport edge cases', () => {
  it('answers malformed JSON with a JSON-RPC parse error (HTTP 400), not a 500', async () => {
    const res = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

    const agent = await fetch(`${app.server.url}/api/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    expect(agent.status).toBe(400);
    expect(await agent.json()).toEqual({ error: 'Parse error' });
  });

  it('opens a server-to-client SSE stream on GET', async () => {
    const sid = await initSession();
    const ctrl = new AbortController();
    const res = await fetch(mcpUrl, { headers: { accept: 'text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(app.server.sessions.get(sid)!.streams).toBe(1);
    ctrl.abort();
    await expect.poll(() => app.server.sessions.get(sid)?.streams).toBe(0);
  });

  it('ends a session on DELETE; the id stops working', async () => {
    const sid = await initSession();
    expect((await listTools(sid)).status).toBe(200);
    const del = await fetch(mcpUrl, { method: 'DELETE', headers: { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' } });
    expect(del.status).toBe(200);
    expect((await listTools(sid)).status).toBe(404);
  });

  it('rejects a foreign Host header (DNS rebinding guard)', async () => {
    const { request } = await import('node:http');
    const port = new URL(mcpUrl).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `evil.example:${port}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }));
    });
    expect(status).toBe(403);
  });
});

describe('session limits', () => {
  it('drops the least recently used session at the cap, and idle sessions after the timeout', async () => {
    const { createContext } = await import('../../src/context.js');
    const { startServer } = await import('../../src/server/http.js');
    const ctx = createContext({ host: '127.0.0.1', port: 0, stateFile: null, offline: true, videoSafe: false, demo: true, refreshMinutes: 0 });
    const server = await startServer(ctx, { agent: async () => ({}), port: 0, maxSessions: 2, sessionIdleMs: 60_000 });
    const url = `${server.url}/mcp`;
    try {
      const a = await initSession(url);
      const b = await initSession(url);
      expect((await listTools(b, url)).status).toBe(200); // b is now more recent than a
      const c = await initSession(url);
      expect(server.sessions.size).toBe(2);
      expect((await listTools(a, url)).status).toBe(404);
      expect((await listTools(c, url)).status).toBe(200);

      expect(await server.sweepSessions(Date.now() + 30_000)).toBe(0);
      expect(await server.sweepSessions(Date.now() + 61_000)).toBe(2);
      expect(server.sessions.size).toBe(0);
      expect((await listTools(b, url)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
