// Claude 실호출 경로 테스트(키·과금 없음): 가짜 Anthropic HTTP 응답으로 요청 모양·추가 전용 대화·거절·결제 실패·지연 폴백·사용량 기록을 확인한다
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type RunningApp } from '../../src/app.js';
import { createAgentService, isPermanentModelError } from '../../src/agent/api.js';
import type { AgentReply } from '../../src/agent/planner.js';
import { anthropicModel, RecordingTransport } from '../../src/agent/strands.js';

let app: RunningApp;
beforeAll(async () => {
  app = await startApp({ HOME_AHEAD_DEMO: '1', HOME_AHEAD_OFFLINE: '1', HOME_AHEAD_AGENT: 'planner' }, { port: 0 });
});
afterAll(async () => app?.close());

type Block = { thinking: string } | { tool: string; input: Record<string, unknown> } | { text: string };
type Scripted = { blocks: Block[]; stop: 'tool_use' | 'end_turn' | 'refusal'; delayMs?: number } | { status: number } | 'hang';

/** A Messages API stream as server-sent events. */
function sse(blocks: Block[], stop: string): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('message_start', {
    message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 } },
  });
  blocks.forEach((b, index) => {
    if ('thinking' in b) {
      out += ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.thinking } });
    } else if ('tool' in b) {
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_${index}`, name: b.tool, input: {} } });
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    }
    out += ev('content_block_stop', { index });
  });
  out += ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 40 } });
  return out + ev('message_stop', {});
}

/** Fake Anthropic API: answers each request with the next scripted response and records what was sent. */
function fakeApi(script: Scripted[]) {
  const requests: { body: Record<string, any>; headers: Record<string, string> }[] = [];
  const fetch = async (_url: unknown, init: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    requests.push({ body: JSON.parse(String(init.body)), headers });
    const next = script.shift() ?? { blocks: [{ text: 'Done.' }], stop: 'end_turn' };
    if (next === 'hang') {
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    if ('status' in next) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low.' } }), { status: next.status, headers: { 'content-type': 'application/json' } });
    }
    if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs));
    return new Response(sse(next.blocks, next.stop), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { requests, fetch };
}

async function service(script: Scripted[], opts: { env?: NodeJS.ProcessEnv; firstToolTimeoutMs?: number } = {}) {
  const api = fakeApi(script);
  const model = await anthropicModel({ apiKey: 'test-key', clientConfig: { fetch: api.fetch, maxRetries: 0, timeout: 3000 } });
  const svc = await createAgentService(`${app.server.url}/mcp`, () => app.ctx.clock.localNow(), opts.env ?? {}, {
    model: { model, label: 'Claude claude-opus-5-5' },
    firstToolTimeoutMs: opts.firstToolTimeoutMs,
  });
  const say = async (text: string) => (await svc.handle({ text, conversationId: 'c' })) as AgentReply;
  return { svc, say, requests: api.requests };
}

const highChair = { category: 'high_chair', model: 'TB-HC6900', source: 'hand_me_down' };

describe('Claude through Strands, against a fake Anthropic API', () => {
  it('sends the request Claude Opus 5.5 expects and keeps the conversation append-only', async () => {
    app.ctx.resetDemo();
    const { svc, say, requests } = await service([
      { blocks: [{ thinking: 'sig-1' }, { tool: 'check_secondhand_item', input: highChair }], stop: 'tool_use' },
      { blocks: [{ thinking: 'sig-2' }, { text: "Please don't use that high chair." }], stop: 'end_turn' },
      { blocks: [{ text: 'Sure.' }], stop: 'end_turn' },
    ]);
    const r = await say('My sister gave us a high chair, model TB-HC6900.');
    expect(r.mode).toBe('strands');
    expect(r.model).toBe('Claude claude-opus-5-5');
    expect(r.spoken).toBe("Please don't use that high chair.");
    expect(r.calls.map((c) => c.tool)).toEqual(['check_secondhand_item']);
    expect(r.ui?.result.verdict).toBe('do_not_use');
    expect(r.usage).toMatchObject({ modelCalls: 2, inputTokens: 24, outputTokens: 80, cacheReadInputTokens: 1800, cacheWriteInputTokens: 200 });

    const [first, second] = requests;
    expect(first.body).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, fallbacks: 'default', stream: true });
    expect(first.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    for (const k of ['temperature', 'top_p', 'tool_choice']) expect(first.body).not.toHaveProperty(k);
    expect(first.body.max_tokens).toBeGreaterThanOrEqual(4000);
    expect(first.body.tools.map((t: { name: string }) => t.name)).toContain('confirm_supply_order');
    expect(first.body.messages[0].content[0].text).toMatch(/^\[Friday, August 28, 2026 at .+\] My sister gave us/);
    // The tool result reaches the model with the serialized data (the cart token lives there).
    const toolResult = second.body.messages[2].content.find((b: { type: string }) => b.type === 'tool_result');
    expect(JSON.stringify(toolResult.content)).toContain('do_not_use');
    // The thinking block comes back unchanged, signature and all.
    expect(second.body.messages[1].content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig-1' });

    app.ctx.clock.advanceDays(21);
    await say('Thanks.');
    const third = requests[2];
    // Next turn: same system prompt and tools, every earlier message byte-identical, the new date in the new user turn.
    expect(JSON.stringify(third.body.system)).toBe(JSON.stringify(first.body.system));
    expect(JSON.stringify(third.body.tools)).toBe(JSON.stringify(first.body.tools));
    const stripCache = (m: unknown) => JSON.stringify(m).replace(/,"cache_control":\{[^}]*\}/g, '');
    expect(stripCache(third.body.messages.slice(0, 3))).toBe(stripCache(second.body.messages));
    expect(third.body.messages[3].content).toEqual([{ type: 'thinking', thinking: '', signature: 'sig-2' }, { type: 'text', text: "Please don't use that high chair." }]);
    expect(JSON.stringify(third.body.messages.at(-1))).toContain('Friday, September 18, 2026');
    await svc.close();
  });

  it('tells the model about alerts the display announced since its last turn', async () => {
    app.ctx.resetDemo();
    const { svc, say, requests } = await service([]);
    await say('Hello.');
    app.ctx.clock.advanceDays(28);
    expect(app.ctx.service.sweep(true).alerts.length).toBeGreaterThanOrEqual(1);
    await say('What should I do?');
    const turn = JSON.stringify(requests.at(-1)!.body.messages.at(-1));
    expect(turn).toMatch(/Announced on the display since the last turn: .*dresser/);
    await say('Okay.');
    expect(JSON.stringify(requests.at(-1)!.body.messages.at(-1))).not.toMatch(/Announced/);
    await svc.close();
  });

  it('lets the planner answer when Claude declines before any tool runs', async () => {
    app.ctx.resetDemo();
    const { svc, say } = await service([{ blocks: [], stop: 'refusal' }]);
    const r = await say('My sister is giving us her old high chair and crib.');
    expect(r.mode).toBe('planner');
    expect(r.spoken).toMatch(/^Happy to check both\. What model number/);
    expect(svc.mode).toBe('strands'); // one refusal does not switch the model off
    await svc.close();
  });

  it('switches to the planner for good when the key is refused for billing (credit gone)', async () => {
    app.ctx.resetDemo();
    const { svc, say, requests } = await service([{ status: 402 }]);
    let r = await say('My sister is giving us her old high chair and crib.');
    expect(r.mode).toBe('planner');
    expect(svc.mode).toBe('planner');
    r = await say('It says TB-HC6900.');
    expect(r.mode).toBe('planner');
    expect(r.spoken).toMatch(/don't use that high chair/);
    expect(requests).toHaveLength(1); // no second try against a dead key
    await svc.close();
  });

  it('classifies key, billing, access and model errors as permanent, and overload as temporary', () => {
    const wrap = (status: number) => Object.assign(new Error('model'), { cause: Object.assign(new Error('api'), { status }) });
    expect([401, 402, 403, 404].map((s) => isPermanentModelError(wrap(s)))).toEqual([true, true, true, true]);
    expect([429, 500, 529].map((s) => isPermanentModelError(wrap(s)))).toEqual([false, false, false]);
    expect(isPermanentModelError(new Error('network'))).toBe(false);
  });

  it('lets the planner answer when Claude is slow, and keeps the late run from touching the home', async () => {
    app.ctx.resetDemo();
    const { svc, say, requests } = await service(
      [
        // The tool call arrives after the planner has already answered.
        { blocks: [{ tool: 'add_items', input: { items: [{ category: 'bookcase', name: 'late bookcase' }] } }], stop: 'tool_use', delayMs: 700 },
        { blocks: [{ text: 'Added.' }], stop: 'end_turn' },
      ],
      { firstToolTimeoutMs: 250 },
    );
    const t0 = Date.now();
    const r = await say('My sister is giving us her old high chair and crib.');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.mode).toBe('planner');
    expect(r.spoken).toMatch(/^Happy to check both/);
    await new Promise((res) => setTimeout(res, 1500));
    expect(app.ctx.service.household().items.some((i) => i.name === 'late bookcase')).toBe(false);
    // If Strands went on to run the tool, the call was refused before it reached the server.
    const followUp = requests[1]?.body.messages.at(-1)?.content.find((b: { type: string }) => b.type === 'tool_result');
    if (followUp) expect(followUp.is_error).toBe(true);
    expect(svc.mode).toBe('strands');
    await svc.close();
  });

  it('refuses tool calls from a run that was given up on, and nothing else', async () => {
    const sent: string[] = [];
    const inner = { send: async (m: { method?: string }) => void sent.push(String(m.method)) } as unknown as ConstructorParameters<typeof RecordingTransport>[0];
    const t = new RecordingTransport(inner);
    t.blocked = true;
    await expect(t.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_items', arguments: {} } })).rejects.toThrow(/planner/);
    await t.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    t.blocked = false;
    await t.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_items', arguments: {} } });
    expect(sent).toEqual(['tools/list', 'tools/call']);
  });

  it('falls back when the model never answers at all', async () => {
    app.ctx.resetDemo();
    const { svc, say } = await service(['hang'], { firstToolTimeoutMs: 250 });
    const t0 = Date.now();
    const r = await say('Is our dresser recalled?');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.mode).toBe('planner');
    expect(r.calls[0].tool).toBe('check_secondhand_item');
    await svc.close();
  });

  it('writes the token usage of every request when HOME_AHEAD_USAGE_LOG is set', async () => {
    app.ctx.resetDemo();
    const log = join(mkdtempSync(join(tmpdir(), 'home-ahead-')), 'usage.jsonl');
    const { svc, say } = await service(
      [
        { blocks: [{ tool: 'check_secondhand_item', input: highChair }], stop: 'tool_use' },
        { blocks: [{ text: 'Done.' }], stop: 'end_turn' },
      ],
      { env: { HOME_AHEAD_USAGE_LOG: log } },
    );
    await say('Check this high chair, model TB-HC6900.');
    expect(existsSync(log)).toBe(true);
    const rows = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: 'claude-opus-5-5', stopReason: 'toolUse', usage: { input_tokens: 12, output_tokens: 40, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 } });
    await svc.close();
  });
});
