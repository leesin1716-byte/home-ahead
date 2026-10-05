// 데모 3막 시나리오를 서비스 계층에서 끝까지 돌려 상태 변화와 음성 응답 규칙을 확인한다
import { describe, expect, it, beforeEach } from 'vitest';
import { createContext, type AppContext } from '../../src/context.js';
import { speechProblems } from '../../src/domain/speech.js';

const config = { host: '127.0.0.1', port: 0, stateFile: null, offline: true, videoSafe: false, demo: true, refreshMinutes: 0 };

function spoken(o: { spoken: string }) {
  expect(speechProblems(o.spoken), o.spoken).toEqual([]);
  return o.spoken;
}

describe('demo scenario (service level)', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = createContext(config);
  });

  it('act 1: hand-me-down high chair matches a real recall, crib needs its bumpers out', () => {
    const s = ctx.service;
    const ask = s.checkSecondhandItem({ category: 'high_chair', source: 'hand_me_down' });
    expect(ask.data.verdict).toBe('need_info');
    expect(spoken(ask)).toMatch(/model number/);

    const chair = s.checkSecondhandItem({ category: 'high_chair', model: 'TB-HC6900', source: 'hand_me_down' });
    expect(chair.data.verdict).toBe('do_not_use');
    expect(chair.data.recall?.recallNumber).toBe('26290');
    expect(chair.data.recall?.stopUsing).toBe('yes');
    expect(spoken(chair)).toMatch(/don't use that high chair.*February 2026.*full refund/);

    const crib = s.checkSecondhandItem({ category: 'crib', model: 'CR-2208', hasBumpers: true, source: 'hand_me_down', room: 'nursery' });
    expect(crib.data.verdict).toBe('fix_first');
    expect(crib.data.recall).toBeNull();
    expect(spoken(crib)).toMatch(/bumpers are banned/);

    const h = s.household();
    expect(h.items.find((i) => i.category === 'high_chair')?.doNotUse).toBe(true);
    expect(h.recallMatches.map((m) => m.recallNumber)).toEqual(['26290']);
  });

  it('act 2: parent says she pulled up; stage moves ahead of the age default and the plan changes', () => {
    const s = ctx.service;
    ctx.clock.advanceDays(21); // 2026-09-18
    const r = s.setChildStage({ milestone: 'She pulled herself up on the couch today!' });
    expect((r.data as any).child?.stage).toBe('cruising');
    expect((r.data as any).changed).toBe(true);
    expect((r.data as any).newThisStage).toEqual(expect.arrayContaining(['Anchor the dresser to the wall', 'Strap the TV to the wall']));
    expect(spoken(r)).toMatch(/anchor the dresser/);

    const cart = s.prepareSupplyOrder({});
    const order = cart.data.order!;
    expect(order.lines.map((l: { sku: string }) => l.sku).sort()).toEqual(['anchor-kit', 'cord-cleats', 'tv-strap']);
    expect(spoken(cart)).toMatch(/^From the demo store: three safety items for \$\d+\.\d\d, listed on screen\. Should I place the order\?$/);

    const bad = s.confirmSupplyOrder({ token: 'nope' });
    expect(bad.isError).toBe(true);
    const ok = s.confirmSupplyOrder({ token: order.token });
    expect(ok.data.alreadyConfirmed).toBe(false);
    const again = s.confirmSupplyOrder({ token: order.token });
    expect(again.data.alreadyConfirmed).toBe(true);
    expect(s.household().orders.filter((o) => o.status === 'confirmed')).toHaveLength(1);

    const sched = s.updateTask({ task: 'anchor the dresser', action: 'schedule', when: '2026-09-19T10:00' });
    expect(spoken(sched)).toMatch(/Saturday, September 19 at 10 AM/);
  });

  it('act 3: a recall published later reaches the home, and anchoring changes the advice', () => {
    const s = ctx.service;
    ctx.clock.advanceDays(21);
    s.setChildStage({ observedStage: 'cruising' });
    ctx.clock.advanceDays(1);
    const done = s.updateTask({ task: 'we anchored the dresser and the TV' });
    expect(done.data.tasks?.map((t: { title: string }) => t.title).sort()).toEqual(['Anchor the dresser to the wall', 'Strap the TV to the wall']);
    expect(s.household().items.find((i) => i.id === 'it_dresser')?.anchored).toBe(true);

    // Before 2026-09-24 the dresser recall is not public yet.
    expect(s.sweep(true).alerts).toHaveLength(0);
    ctx.clock.advanceDays(6); // 2026-09-25
    let notified = 0;
    ctx.alertListeners.add(() => notified++);
    const swept = s.sweep(true);
    expect(swept.alerts.map((a) => a.recallNumber)).toEqual(['26794']);
    expect(notified).toBe(1);
    expect(spoken(swept.alerts[0])).toMatch(/anchored it, it can stay in use/);

    const g = s.getRecallGuidance({});
    expect(g.data.recall?.stopUsing).toBe('if_not_anchored');
    expect(spoken(g)).toMatch(/free repair kit/);
    expect(s.alerts().unread).toHaveLength(0);

    const req = s.updateTask({ recall: 'latest', remedyStatus: 'requested' });
    expect(spoken(req)).toMatch(/two weeks/);
    expect(s.household().recallMatches.find((m) => m.recallNumber === '26794')?.remedyStatus).toBe('requested');

    const next = s.getSafetyPlan({ stage: 'next' });
    expect((next.data as any).stage).toBe('walking');
    expect((next.data as any).isPreview).toBe(true);
    spoken(next);
  });

  it('check_recalls lists the open matches and says how many notices it searched', () => {
    const s = ctx.service;
    s.checkSecondhandItem({ category: 'high_chair', model: 'TB-HC6900' });
    const r = s.checkRecalls({});
    expect(r.data.matches).toHaveLength(1);
    expect(r.data.noticesSearched).toBeGreaterThan(100);
    spoken(r);
  });

  it('errors are a single speakable sentence', () => {
    const s = ctx.service;
    for (const o of [s.getRecallGuidance({ recallNumber: '00000' }), s.updateTask({ task: 'paint the fence' }), s.confirmSupplyOrder({ token: 'x' })]) {
      expect(o.isError).toBe(true);
      spoken(o);
    }
  });

  it('video-safe mode keeps brand names off the card', () => {
    const safe = createContext({ ...config, videoSafe: true });
    const r = safe.service.checkSecondhandItem({ category: 'high_chair', model: 'TB-HC6900' });
    const card = JSON.stringify({ ...r.data.recall, url: '' });
    expect(card).not.toMatch(/bicystar/i);
    expect(r.data.recall?.heading).toBe('High chair recall');
  });

  it('video-safe mode replaces an email that contains a brand as a whole', () => {
    const safe = createContext({ ...config, videoSafe: true });
    safe.clock.advanceDays(28); // 2026-09-25, after the dresser recall
    safe.service.sweep(true);
    const g = safe.service.getRecallGuidance({ recallNumber: '26794' });
    const text = JSON.stringify({ ...g.data.recall, url: "" });
    expect(text).not.toMatch(/yuyitop|aitjunz|outlook|recall\.the/i);
    expect(text).toContain('contact the company at the email address in the notice');
  });
});
