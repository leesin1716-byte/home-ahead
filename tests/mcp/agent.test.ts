// 에이전트 통합 테스트: 결정적 플래너로 데모 3막 대화를 /api/agent 로 끝까지 돌리고, Strands 경로는 대본 모델로 확인한다
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { startApp, type RunningApp } from '../../src/app.js';
import { StrandsAgentRunner } from '../../src/agent/strands.js';
import { extractModel, parseWhen } from '../../src/agent/planner.js';
import { speechProblems } from '../../src/domain/speech.js';

let app: RunningApp;

beforeAll(async () => {
  app = await startApp({ HOME_AHEAD_DEMO: '1', HOME_AHEAD_OFFLINE: '1', HOME_AHEAD_AGENT: 'planner' }, { port: 0 });
});
afterAll(async () => app?.close());

async function say(text: string) {
  const res = await fetch(`${app.server.url}/api/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, conversationId: 'test' }),
  });
  const body = await res.json();
  expect(speechProblems(body.spoken), body.spoken).toEqual([]);
  return body as { spoken: string; calls: { tool: string; args: Record<string, unknown> }[]; ui: { tool: string; resourceUri: string; result: Record<string, any> } | null; mode: string; protocolVersion: string };
}

async function advance(days: number) {
  const res = await fetch(`${app.server.url}/api/demo/advance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days }) });
  return res.json();
}

describe('planner helpers', () => {
  it('finds model numbers in speech', () => {
    expect(extractModel('It says TB-HC6900.')).toBe('TB-HC6900');
    expect(extractModel('Model CR-2208, and yes, it has bumpers.')).toBe('CR-2208');
    expect(extractModel('an 8-drawer dresser')).toBeUndefined();
  });
  it('resolves "Saturday morning" against the simulated clock', () => {
    expect(parseWhen('saturday morning', new Date('2026-09-18T18:30:00Z'))).toBe('2026-09-19T10:00');
    expect(parseWhen('tomorrow at 3 pm', new Date('2026-09-18T18:30:00Z'))).toBe('2026-09-19T15:00');
    expect(parseWhen('sometime', new Date())).toBeUndefined();
  });
});

describe('demo conversation through /api/agent (deterministic planner)', () => {
  it('runs all three acts', async () => {
    // Act 1: hand-me-downs.
    let r = await say('My sister is giving us her old high chair and crib.');
    expect(r.mode).toBe('planner');
    expect(r.protocolVersion).toBe('2025-11-25');
    expect(r.calls.map((c) => c.tool)).toEqual(['check_secondhand_item']);
    expect(r.spoken).toMatch(/^Happy to check both\. What model number/);

    r = await say('It says TB-HC6900.');
    expect(r.calls.map((c) => c.tool)).toEqual(['check_secondhand_item', 'check_secondhand_item']);
    expect(r.ui?.result.verdict).toBe('do_not_use');
    expect(r.ui?.resourceUri).toMatch(/^ui:\/\/home-ahead\/recall-card-/);
    expect(r.spoken).toMatch(/don't use that high chair.*Now the crib: what model number is on its label\? Does it come with bumper pads\?/);

    r = await say('Model CR-2208, and yes, it has bumpers.');
    expect(r.ui?.result.verdict).toBe('fix_first');
    expect(r.spoken).toMatch(/bumpers are banned/);

    // Act 2: three weeks later she pulls up.
    await advance(21);
    r = await say('She pulled herself up on the couch today!');
    expect(r.calls[0]).toMatchObject({ tool: 'set_child_stage' });
    expect(r.ui?.result.stage).toBe('cruising');
    expect(r.spoken).toMatch(/Want me to get the supplies\?$/);

    r = await say('Yes please.');
    expect(r.calls[0].tool).toBe('prepare_supply_order');
    expect(r.ui?.resourceUri).toMatch(/cart-/);

    r = await say('Yes, place the order.');
    expect(r.calls[0].tool).toBe('confirm_supply_order');
    expect(r.ui?.result.order.status).toBe('confirmed');

    r = await say('Put anchoring the dresser on the calendar for Saturday morning.');
    expect(r.calls[0]).toMatchObject({ tool: 'update_task', args: { action: 'schedule', when: '2026-09-19T10:00' } });

    // Act 3: they anchor it; a week later a real recall reaches the home.
    await advance(1);
    r = await say('We anchored the dresser and the TV.');
    expect(r.spoken).toMatch(/anchor the dresser to the wall and strap the TV to the wall/);
    const adv = await advance(6);
    expect(adv.newAlerts).toBeGreaterThanOrEqual(1);

    r = await say('What should I do?');
    expect(r.calls[0].tool).toBe('get_recall_guidance');
    expect(r.ui?.result.recall.recallNumber).toBe('26794');
    expect(r.spoken).toMatch(/anchored, so it can stay in use/);

    r = await say('I emailed them for the repair kit.');
    expect(r.calls[0]).toMatchObject({ tool: 'update_task', args: { remedyStatus: 'requested' } });

    r = await say('Are we ready for the next stage?');
    expect(r.ui?.result.isPreview).toBe(true);
    expect(r.ui?.result.stage).toBe('walking');
  });

  it('falls back to a short help line for things it does not understand', async () => {
    const r = await say('What is the weather?');
    expect(r.calls).toHaveLength(0);
    expect(r.spoken).toMatch(/hand-me-downs/);
  });
});

/** A scripted model: asks for one tool call, then answers with the tool's spoken text. */
class ScriptedModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'scripted' };
  calls = 0;
  updateConfig(c: BaseModelConfig) {
    this.config = { ...this.config, ...c };
  }
  getConfig() {
    return this.config;
  }
  async *stream(messages: Message[]): AsyncGenerator<ModelStreamEvent> {
    this.calls++;
    yield { type: 'modelMessageStartEvent', role: 'assistant' } as const;
    const last = messages[messages.length - 1];
    const toolResult = (last.content as unknown as { type: string; content?: { type: string; text?: string }[] }[]).find((b) => b.type === 'toolResultBlock');
    if (!toolResult) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'check_secondhand_item', toolUseId: 'tu_1' } } as const;
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ category: 'high_chair', model: 'TB-HC6900' }) } } as const;
      yield { type: 'modelContentBlockStopEvent' } as const;
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' } as const;
      return;
    }
    const text = toolResult.content?.find((c) => c.type === 'textBlock')?.text ?? 'Done.';
    yield { type: 'modelContentBlockStartEvent' } as const;
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } } as const;
    yield { type: 'modelContentBlockStopEvent' } as const;
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' } as const;
  }
}

describe('Strands Agents path (SDK v1 MCP client, scripted model, no API key)', () => {
  it('lets the Strands agent call the MCP tool and keeps structuredContent for the MCP App', async () => {
    app.ctx.resetDemo();
    const model = new ScriptedModel();
    const runner = new StrandsAgentRunner({
      mcpUrl: `${app.server.url}/mcp`,
      model: model as unknown as Model,
      now: () => app.ctx.clock.now(),
      uiFor: (t) => (t === 'check_secondhand_item' ? 'ui://home-ahead/recall-card-test.html' : undefined),
    });
    const reply = await runner.handle('My sister gave us a high chair, model TB-HC6900.');
    expect(model.calls).toBe(2);
    expect(reply.mode).toBe('strands');
    expect(reply.calls.map((c) => c.tool)).toEqual(['check_secondhand_item']);
    expect(reply.calls[0].result.structuredContent.verdict).toBe('do_not_use');
    expect(reply.ui?.result.recall).toMatchObject({ recallNumber: '26290' });
    expect(reply.spoken).toMatch(/don't use that high chair/);
    expect(reply.protocolVersion).toBe('2025-11-25');
    await runner.close();
  });
});
