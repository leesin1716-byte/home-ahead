// 실호출 테스트(npm run test:live, 키 필요·과금): 데모 3막을 Claude 로 돌려 도구 선택이 결정적 플래너와 같은 결과에 닿는지 본다
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type RunningApp } from '../../src/app.js';
import type { AgentReply } from '../../src/agent/planner.js';
import { speechProblems } from '../../src/domain/speech.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const hasKey = !!process.env.ANTHROPIC_API_KEY;

let app: RunningApp;
const turns: { text: string; ms: number; tools: string[]; spoken: string; usage?: AgentReply['usage'] }[] = [];

beforeAll(async () => {
  if (!hasKey) return;
  mkdirSync('test-results', { recursive: true });
  app = await startApp(
    {
      ...process.env,
      HOME_AHEAD_DEMO: '1',
      HOME_AHEAD_OFFLINE: '1',
      HOME_AHEAD_AGENT: '',
      HOME_AHEAD_USAGE_LOG: process.env.HOME_AHEAD_USAGE_LOG ?? 'test-results/claude-usage.jsonl',
    },
    { port: 0 },
  );
});
afterAll(async () => {
  if (turns.length) writeFileSync('test-results/live-run.json', JSON.stringify(turns, null, 2));
  await app?.close();
});

async function say(text: string): Promise<AgentReply> {
  const t0 = Date.now();
  const r = (await app.agent.handle({ text, conversationId: 'live' })) as AgentReply;
  turns.push({ text, ms: Date.now() - t0, tools: r.calls.map((c) => c.tool), spoken: r.spoken, usage: r.usage });
  expect(r.mode, `${text} fell back to the planner`).toBe('strands');
  expect.soft(speechProblems(r.spoken), r.spoken).toEqual([]);
  expect.soft(r.spoken, 'markdown in a spoken reply').not.toMatch(/\*\*|^\s*[-*•] |^#/m);
  return r;
}

async function advance(days: number): Promise<{ newAlerts: number }> {
  const res = await fetch(`${app.server.url}/api/demo/advance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days }) });
  return res.json();
}

const results = (r: AgentReply, tool: string) => r.calls.filter((c) => c.tool === tool && !c.result.isError).map((c) => c.result.structuredContent as Record<string, any>);

describe.skipIf(!hasKey)('demo conversation with Claude through Strands (live API)', () => {
  it('reaches the same tool results as the planner in all three acts', { timeout: 600_000 }, async () => {
    expect(app.agent.mode).toBe('strands');

    // Act 1: hand-me-downs.
    let r = await say('My sister is giving us her old high chair and crib.');
    expect(r.calls.map((c) => c.tool)).toContain('check_secondhand_item');
    expect(r.spoken).toMatch(/model/i);

    r = await say('It says TB-HC6900.');
    expect(results(r, 'check_secondhand_item').map((x) => x.verdict)).toContain('do_not_use');
    expect(r.ui?.result.recall).toMatchObject({ recallNumber: '26290' });

    r = await say('Model CR-2208, and yes, it has bumpers.');
    expect(results(r, 'check_secondhand_item').map((x) => x.verdict)).toContain('fix_first');
    expect(r.spoken).toMatch(/bumper/i);

    // Act 2: three weeks later she pulls up.
    await advance(21);
    r = await say('She pulled herself up on the couch today!');
    expect(results(r, 'set_child_stage').map((x) => x.stage)).toContain('cruising');

    r = await say('Yes please.');
    expect(r.calls.map((c) => c.tool)).toContain('prepare_supply_order');
    expect(r.calls.map((c) => c.tool)).not.toContain('confirm_supply_order');

    r = await say('Yes, place the order.');
    expect(results(r, 'confirm_supply_order').map((x) => x.order?.status)).toContain('confirmed');

    r = await say('Put anchoring the dresser on the calendar for Saturday morning.');
    const scheduled = r.calls.find((c) => c.tool === 'update_task' && c.args.action === 'schedule');
    expect(String(scheduled?.args.when)).toMatch(/^2026-09-19T(0[7-9]|1[01]):/);

    // Act 3: they anchor it; a week later a real recall reaches the home.
    await advance(1);
    r = await say('We anchored the dresser and the TV.');
    expect(r.calls.map((c) => c.tool)).toContain('update_task');
    const household = app.ctx.service.household();
    expect(household.items.find((i) => i.category === 'dresser')?.anchored).toBe(true);

    expect((await advance(6)).newAlerts).toBeGreaterThanOrEqual(1);
    r = await say('What should I do?');
    expect(results(r, 'get_recall_guidance').map((x) => x.recall?.recallNumber)).toContain('26794');
    expect(r.spoken).toMatch(/anchor/i);
  });
});
