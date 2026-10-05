// 리뷰 반영 확인: 과거 시각 예약 거절, 가구 시간대, 주문 토큰 만료, 새 물건의 단계 안내, 목록 밖 완료 보고, 보유 물건 질문, 뷰 CSP
import { beforeEach, describe, expect, it } from 'vitest';
import { configFromEnv, createContext, type AppContext } from '../../src/context.js';
import { Clock } from '../../src/domain/clock.js';
import { parseWhen } from '../../src/agent/planner.js';
import { speechProblems } from '../../src/domain/speech.js';
import { withCsp } from '../../src/sim/csp.js';

const config = { host: '127.0.0.1', port: 0, stateFile: null, offline: true, videoSafe: false, demo: true, refreshMinutes: 0 };

function spoken(o: { spoken: string }) {
  expect(speechProblems(o.spoken), o.spoken).toEqual([]);
  return o.spoken;
}

let ctx: AppContext;
beforeEach(() => {
  ctx = createContext(config); // demo clock: Friday, August 28, 2026, 18:30 UTC
});

describe('scheduling', () => {
  it('refuses a time that has already passed and accepts a future one', () => {
    ctx.clock.advanceDays(21); // Friday, September 18
    ctx.service.setChildStage({ milestone: 'She pulled herself up on the couch today!' });
    const past = ctx.service.updateTask({ task: 'anchor the dresser', action: 'schedule', when: '2026-08-29T10:00' });
    expect(past.isError).toBe(true);
    expect(spoken(past)).toMatch(/Saturday, August 29 at 10 AM has already passed\. When should I schedule it\?/);
    const ok = ctx.service.updateTask({ task: 'anchor the dresser', action: 'schedule', when: '2026-09-19T10:00' });
    expect(ok.isError).toBeFalsy();
  });
});

describe('household time zone', () => {
  it('reads wall-clock time in the household zone', () => {
    const c = new Clock('America/Los_Angeles');
    c.set('2026-09-19T05:00:00Z'); // still Friday evening in California
    expect(c.localIso()).toBe('2026-09-18T22:00');
    expect(c.localNow().getUTCDay()).toBe(5);
    // "Saturday morning" said on Friday night means tomorrow, not next week.
    expect(parseWhen('saturday morning', c.localNow())).toBe('2026-09-19T10:00');
    // Read in UTC (the old behavior) it is already Saturday, so it would land a week late.
    expect(parseWhen('saturday morning', c.now())).toBe('2026-09-26T10:00');
  });

  it('demo mode stays on UTC; an unknown zone falls back to UTC', () => {
    expect(configFromEnv({ HOME_AHEAD_DEMO: '1' }).timeZone).toBe('UTC');
    expect(configFromEnv({ HOME_AHEAD_TZ: 'Asia/Seoul' }).timeZone).toBe('Asia/Seoul');
    expect(configFromEnv({ HOME_AHEAD_TZ: 'Mars/Olympus' }).timeZone).toBe('UTC');
  });

  it('the household resource tells the screen which zone to show', () => {
    expect(ctx.service.householdSummary().timeZone).toBe('UTC');
  });
});

describe('orders', () => {
  it('an expired cart cannot be confirmed, and an unknown token is refused', () => {
    ctx.clock.advanceDays(21);
    ctx.service.setChildStage({ milestone: 'She pulled herself up on the couch today!' });
    const cart = ctx.service.prepareSupplyOrder({});
    ctx.clock.advanceDays(1);
    const late = ctx.service.confirmSupplyOrder({ token: cart.data.order!.token });
    expect(late.isError).toBe(true);
    expect(spoken(late)).toMatch(/expired/);
    expect(ctx.service.household().orders.every((o) => o.status !== 'confirmed')).toBe(true);
    expect(ctx.service.confirmSupplyOrder({ token: 'x'.repeat(12) }).isError).toBe(true);
  });
});

describe('adding things to the home', () => {
  it('a new bookcase gets anchoring advice for the stage it matters', () => {
    const early = ctx.service.addItems({ items: [{ category: 'bookcase', room: 'living room' }] });
    expect(spoken(early)).toBe('Added the bookcase. Once Ava starts pulling up and cruising, anchor the bookcase to the wall.');
  });

  it('when the stage already calls for it, the task goes on the plan', () => {
    ctx.clock.advanceDays(21);
    ctx.service.setChildStage({ milestone: 'She pulled herself up on the couch today!' });
    const r = ctx.service.addItems({ items: [{ category: 'bookcase', room: 'living room' }] });
    expect(spoken(r)).toBe('Added the bookcase. Since Ava is pulling up and cruising, anchor the bookcase to the wall. I added it to the plan.');
    expect(ctx.service.household().tasks.some((t) => t.title === 'Anchor the bookcase to the wall' && t.status === 'open')).toBe(true);
  });

  it('a toy needs no stage note', () => {
    expect(ctx.service.addItems({ items: [{ category: 'toy' }] }).spoken).toBe('Added the toy.');
  });
});

describe('reporting something done that was not on the list', () => {
  it('remembers that furniture was anchored', () => {
    const r = ctx.service.updateTask({ task: 'We anchored the dresser.', action: 'complete' });
    expect(r.isError).toBeFalsy();
    expect(spoken(r)).toMatch(/^Noted: the dresser is anchored\./);
    expect(ctx.service.household().items.find((i) => i.category === 'dresser')?.anchored).toBe(true);
  });

  it('says plainly when there is nothing to check off', () => {
    const r = ctx.service.updateTask({ task: 'We fixed the blinds.', action: 'complete' });
    expect(r.isError).toBe(true);
    expect(spoken(r)).toMatch(/isn't on your open list/);
  });
});

describe('asking about something the family already owns', () => {
  it('uses the model number on file and does not add a second dresser', () => {
    const before = ctx.service.household().items.length;
    const now = ctx.service.checkSecondhandItem({ category: 'dresser', source: 'owned' });
    expect(now.data.verdict).toBe('use');
    expect(now.data.item.model).toBe('LDQMFJ8D-WH');
    ctx.clock.advanceDays(28); // the dresser recall is published on September 24
    const later = ctx.service.checkSecondhandItem({ category: 'dresser', source: 'owned' });
    expect(later.data.verdict).toBe('fix_first');
    expect(later.data.recall?.recallNumber).toBe('26794');
    expect(ctx.service.household().items).toHaveLength(before);
  });
});

describe('plan sentence', () => {
  it('reads naturally whether or not every item is listed', () => {
    ctx.clock.advanceDays(21);
    ctx.service.addItems({ items: [{ category: 'bookcase', room: 'living room' }, { category: 'tv', name: 'bedroom TV', room: 'bedroom' }] });
    const r = ctx.service.setChildStage({ milestone: 'She pulled herself up on the couch today!' });
    expect(spoken(r)).not.toMatch(/starting with/);
    expect(r.spoken).toMatch(/need attention\. First up: \w/);
  });

  it('the plan read-back says "First up" when it lists only some items', () => {
    ctx.clock.advanceDays(21);
    ctx.service.addItems({ items: [{ category: 'bookcase', room: 'living room' }] });
    ctx.service.setChildStage({ milestone: 'She pulled herself up on the couch today!' });
    const plan = ctx.service.getSafetyPlan({});
    expect(plan.data.openCount).toBeGreaterThan(3);
    expect(spoken(plan)).toMatch(/^For pulling up and cruising, \w+ things are open\. First up: /);
  });

  it('counts recalls in words', () => {
    ctx.service.checkSecondhandItem({ category: 'high_chair', model: 'TB-HC6900', source: 'hand_me_down' });
    expect(spoken(ctx.service.checkRecalls({}))).toMatch(/^One new recall on your list\. /);
    expect(spoken(ctx.service.checkRecalls({}))).toMatch(/^One recall on your list\. /);
  });
});

describe('MCP Apps CSP', () => {
  it('blocks network access unless the view declares a domain', () => {
    const html = withCsp('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>', { connectDomains: [] });
    expect(html).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'">/);
    const open = withCsp('<html><head></head></html>', { connectDomains: ['https://api.example.com'], resourceDomains: ['https://cdn.example.com'] });
    expect(open).toContain('connect-src https://api.example.com');
    expect(open).toContain("img-src data: https://cdn.example.com");
  });
});
