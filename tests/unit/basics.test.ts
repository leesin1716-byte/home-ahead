// 단계 엔진·음성 문장 검사·원자적 저장소 같은 작은 부품의 단위 테스트
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultStageForAge, effectiveStage, stageFromMilestone, ageInMonths, nextStage } from '../../src/domain/stages.js';
import { speechProblems, listPhrase, countPhrase } from '../../src/domain/speech.js';
import { hazardShort } from '../../src/domain/recall-view.js';
import { formatWhen } from '../../src/domain/service.js';
import { emptyHousehold, HouseholdStore } from '../../src/store/store.js';
import { Clock } from '../../src/domain/clock.js';

describe('stages', () => {
  it('maps age to a rough default stage', () => {
    expect(defaultStageForAge(1)).toBe('newborn');
    expect(defaultStageForAge(8.5)).toBe('crawling');
    expect(defaultStageForAge(24)).toBe('climbing');
  });

  it("uses the parent's observation when it is further along, never moves backwards", () => {
    const now = new Date('2026-09-18T12:00:00Z');
    expect(Math.floor(ageInMonths('2026-01', now))).toBe(8);
    expect(effectiveStage({ id: 'c', nickname: 'A', birthMonth: '2026-01' }, now)).toBe('crawling');
    expect(effectiveStage({ id: 'c', nickname: 'A', birthMonth: '2026-01', observedStage: 'cruising' }, now)).toBe('cruising');
    expect(effectiveStage({ id: 'c', nickname: 'A', birthMonth: '2026-01', observedStage: 'rolling' }, now)).toBe('crawling');
  });

  it("understands everyday milestone phrases", () => {
    expect(stageFromMilestone('She pulled herself up on the couch today!')).toBe('cruising');
    expect(stageFromMilestone('he took his first steps')).toBe('walking');
    expect(stageFromMilestone('started crawling')).toBe('crawling');
    expect(stageFromMilestone('she is climbing the bookshelf')).toBe('climbing');
    expect(stageFromMilestone('had a good nap')).toBeUndefined();
    expect(nextStage('climbing')).toBeUndefined();
  });
});

describe('speech', () => {
  it('flags replies that should not be read aloud', () => {
    expect(speechProblems('Stop using the high chair.')).toEqual([]);
    expect(speechProblems('See https://www.cpsc.gov/x')).toContain('contains a URL');
    expect(speechProblems('{"a":1}')).toContain('looks like JSON');
    expect(speechProblems('Task tk_1a2b3c done')).toContain('contains an internal id');
    expect(speechProblems('call check_recalls')).toContain('contains a tool or field name');
    expect(speechProblems('word '.repeat(80))[0]).toMatch(/too long/);
  });

  it('builds natural lists and counts', () => {
    expect(listPhrase(['a', 'b', 'c'])).toBe('a, b, and c');
    expect(countPhrase(2, 'thing')).toBe('two things');
  });

  it('shortens CPSC titles to a spoken hazard', () => {
    expect(hazardShort('Bicystar High Chairs Recalled Due to Risk of Serious Injury or Death from Fall and Entrapment Hazards; Violates Mandatory Standard')).toBe('fall and entrapment hazard');
    expect(hazardShort('Babysense Max View Baby Monitors Recalled Due to Fire Hazard; Manufactured by Hisense')).toBe('fire hazard');
    expect(hazardShort('X Recalls Blinds Due to Strangulation and Entanglement Hazards')).toBe('strangulation and entanglement hazard');
  });

  it('formats floating local times for the calendar', () => {
    expect(formatWhen('2026-09-19T10:00')).toBe('Saturday, September 19 at 10 AM');
    expect(formatWhen('2026-09-19T14:30')).toBe('Saturday, September 19 at 2:30 PM');
  });
});

describe('store', () => {
  it('writes atomically and leaves no temp files behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'home-ahead-'));
    const file = join(dir, 'state', 'household.json');
    const store = new HouseholdStore(file, () => emptyHousehold(new Date('2026-01-01')));
    store.update((h) => h.rooms.push('nursery'));
    store.update((h) => h.rooms.push('kitchen'));
    expect(JSON.parse(readFileSync(file, 'utf8')).rooms).toEqual(['nursery', 'kitchen']);
    expect(readdirSync(join(dir, 'state'))).toEqual(['household.json']);
    const reopened = new HouseholdStore(file, () => emptyHousehold(new Date()));
    expect(reopened.load().rooms).toEqual(['nursery', 'kitchen']);
  });

  it('does not keep a half-applied change when the update throws', () => {
    const store = new HouseholdStore(null, () => emptyHousehold(new Date('2026-01-01')));
    expect(() => store.update((h) => { h.rooms.push('x'); throw new Error('boom'); })).toThrow('boom');
    expect(store.load().rooms).toEqual([]);
  });
});

describe('clock', () => {
  it('can be pinned and advanced for the demo', () => {
    const c = new Clock();
    c.set('2026-08-28T18:30:00Z');
    c.advanceDays(21);
    expect(c.now().toISOString().slice(0, 10)).toBe('2026-09-18');
    expect(c.isSimulated()).toBe(true);
  });
});
