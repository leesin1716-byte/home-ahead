// 재시작 일관성: 실시간 새로고침으로 받은 리콜이 파일에 남아 재시작 뒤에도 리콜 도구가 같은 답을 내는지 확인한다
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, type AppConfig } from '../../src/context.js';
import type { CpscApiRecall } from '../../src/cpsc/normalize.js';
import type { FetchLike } from '../../src/cpsc/client.js';
import { refreshRecalls } from '../../src/server/scheduler.js';
import { speechProblems } from '../../src/domain/speech.js';

/** A made-up notice that is not in the bundled snapshot (number 99001 does not exist at CPSC). */
const LIVE: CpscApiRecall = {
  RecallID: 99001,
  RecallNumber: '99001',
  RecallDate: '2026-10-01T00:00:00',
  Title: 'Testco Recalls Bookcases Due to Risk of Serious Injury or Death from Tip-Over Hazard',
  Description: 'This recall involves Testco five-shelf bookcases, model BK-4410.',
  URL: 'https://www.cpsc.gov/Recalls/2026/test-notice',
  ConsumerContact: 'Testco toll-free',
  Products: [{ Name: 'Testco five-shelf bookcase', Model: 'BK-4410', Type: 'Bookcases', NumberOfUnits: 'About 1,000' }],
  Manufacturers: [{ Name: 'Testco' }],
  Hazards: [{ Name: 'The bookcases can tip over if they are not anchored to the wall.' }],
  Remedies: [{ Name: 'Consumers should immediately stop using the recalled bookcases and contact Testco for a full refund.' }],
  RemedyOptions: [{ Option: 'Refund' }],
};

const fakeCpsc =
  (records: CpscApiRecall[], calls: string[] = []): FetchLike =>
  async (url) => {
    calls.push(url);
    const term = new URL(url).searchParams.get('ProductName');
    return { ok: true, status: 200, json: async () => (term === 'bookcase' ? records : []) };
  };

let dir: string;
let config: AppConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'home-ahead-'));
  config = { host: '127.0.0.1', port: 0, stateFile: join(dir, 'household.json'), offline: false, videoSafe: false, demo: false, refreshMinutes: 0, timeZone: 'UTC' };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function start() {
  const ctx = createContext(config);
  ctx.clock.set('2026-10-05T12:00:00Z');
  return ctx;
}

describe('live recalls survive a restart', () => {
  it('refresh merges a new notice, raises an alert and saves it next to the household file', async () => {
    const ctx = start();
    ctx.service.addItems({ items: [{ category: 'bookcase', model: 'BK-4410', room: 'living room' }] });
    expect(ctx.service.household().recallMatches).toHaveLength(0);

    const calls: string[] = [];
    const r = await refreshRecalls(ctx, fakeCpsc([LIVE], calls));
    expect(r.error).toBeUndefined();
    expect(r.newRecalls).toEqual(['99001']);
    expect(r.newAlerts).toBe(1);
    expect(calls.every((u) => u.includes('RecallDateStart='))).toBe(true);
    const alert = ctx.service.alerts().unread[0];
    expect(alert.recallNumber).toBe('99001');
    expect(speechProblems(alert.spoken)).toEqual([]);

    expect(ctx.recallsFile).toBe(join(dir, 'recalls.json'));
    const saved = JSON.parse(readFileSync(ctx.recallsFile!, 'utf8')) as { recalls: { recallNumber: string }[] };
    expect(saved.recalls.map((x) => x.recallNumber)).toContain('99001');
  });

  it('after a restart (offline), every recall tool still answers about that notice', async () => {
    const first = start();
    first.service.addItems({ items: [{ category: 'bookcase', model: 'BK-4410', room: 'living room' }] });
    await refreshRecalls(first, fakeCpsc([LIVE]));

    config.offline = true; // the CPSC API is down or we are offline: nothing is fetched again
    const ctx = start();
    expect(ctx.index.get('99001')).toBeDefined();

    const check = ctx.service.checkRecalls({});
    expect(check.data.matches.map((m) => m.recallNumber)).toEqual(['99001']);
    const guide = ctx.service.getRecallGuidance({ recallNumber: '99001' });
    expect(guide.isError).toBeFalsy();
    expect(guide.spoken).toMatch(/Stop using the bookcase/);
    const req = ctx.service.updateTask({ recall: '99001', remedyStatus: 'requested' });
    expect(req.isError).toBeFalsy();
    expect(req.spoken).toMatch(/full refund/);
  });

  it('a recorded match whose notice is gone is skipped instead of crashing the tools', async () => {
    const first = start();
    first.service.addItems({ items: [{ category: 'bookcase', model: 'BK-4410', room: 'living room' }] });
    await refreshRecalls(first, fakeCpsc([LIVE]));
    rmSync(first.recallsFile!);
    expect(existsSync(first.recallsFile!)).toBe(false);

    config.offline = true;
    const ctx = start();
    expect(ctx.service.household().recallMatches.map((m) => m.recallNumber)).toEqual(['99001']);
    expect(() => ctx.service.checkRecalls({})).not.toThrow();
    expect(ctx.service.checkRecalls({}).spoken).toMatch(/Nothing matches/);
    const guide = ctx.service.getRecallGuidance({ recallNumber: '99001' });
    expect(guide.isError).toBe(true);
    expect(guide.spoken).toMatch(/don't have an open recall/);
    expect(ctx.service.updateTask({ recall: 'latest', remedyStatus: 'resolved' }).isError).toBe(true);
    expect(() => ctx.service.sweep(true)).not.toThrow();
  });

  it('a failed refresh keeps the snapshot and still re-checks the home', async () => {
    const ctx = start();
    const r = await refreshRecalls(ctx, async () => ({ ok: false, status: 503, json: async () => null }));
    expect(r.error).toMatch(/HTTP 503/);
    expect(r.newRecalls).toEqual([]);
    expect(existsSync(join(dir, 'recalls.json'))).toBe(false);
  });

  it('offline mode never calls the API', async () => {
    config.offline = true;
    const ctx = start();
    const calls: string[] = [];
    const r = await refreshRecalls(ctx, fakeCpsc([LIVE], calls));
    expect(calls).toEqual([]);
    expect(r.fetched).toBe(0);
  });
});
