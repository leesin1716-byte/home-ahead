// 위험 규칙 검증: 모든 규칙에 출처가 있고, CPSC 인용문은 스냅샷 원문에 글자 그대로 있어야 한다
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadRules, findingsFor, RuleFileSchema } from '../../src/domain/rules.js';
import { RecallIndex } from '../../src/cpsc/index.js';
import { emptyHousehold } from '../../src/store/store.js';

const DATA = join(import.meta.dirname, '..', '..', 'data');
const rules = loadRules(join(DATA, 'rules', 'hazards.json'));
const index = RecallIndex.fromSnapshotFile(join(DATA, 'cpsc', 'snapshot.json'));
const catalog = JSON.parse(readFileSync(join(DATA, 'catalog.json'), 'utf8')) as { products: { sku: string }[] };

describe('hazard rules', () => {
  const all = [...rules.home, ...rules.secondhand];

  it('every rule cites at least one source', () => {
    for (const r of all) expect(r.sources.length, r.id).toBeGreaterThan(0);
  });

  it('a rule without a source fails validation', () => {
    const raw = JSON.parse(readFileSync(join(DATA, 'rules', 'hazards.json'), 'utf8'));
    raw.home[0].sources = [];
    expect(RuleFileSchema.safeParse(raw).success).toBe(false);
  });

  it('CPSC quotes appear word for word in the cited notice, at the cited URL', () => {
    for (const r of all) {
      for (const s of r.sources) {
        if (s.kind !== 'cpsc-recall') continue;
        const rec = index.get(s.recallNumber);
        expect(rec, `${r.id} cites ${s.recallNumber}`).toBeDefined();
        expect(rec!.url, r.id).toBe(s.url);
        const text = [rec!.title, rec!.description, ...rec!.hazards, ...rec!.remedies].join(' ');
        expect(text, `${r.id}: "${s.quote}"`).toContain(s.quote);
      }
    }
  });

  it('other government pages record when they were checked', () => {
    for (const r of all) for (const s of r.sources) if (s.kind === 'gov-page') expect(new URL(s.url).hostname).toMatch(/\.gov$/);
  });

  it('every recommended supply exists in the demo catalog', () => {
    const skus = new Set(catalog.products.map((p) => p.sku));
    for (const r of rules.home) for (const s of r.supplies) expect(skus.has(s), `${r.id} -> ${s}`).toBe(true);
  });

  it('anchoring applies once a child pulls up, and stops once the dresser is anchored', () => {
    const h = emptyHousehold(new Date());
    h.items.push({ id: 'it_d', category: 'dresser', name: 'dresser', source: 'owned', anchored: false, addedAt: '', status: 'active' });
    expect(findingsFor(h, 'sitting', rules).map((f) => f.ruleId)).not.toContain('anchor-furniture');
    const f = findingsFor(h, 'cruising', rules).find((x) => x.ruleId === 'anchor-furniture');
    expect(f?.newThisStage).toBe(true);
    h.items[0].anchored = true;
    expect(findingsFor(h, 'cruising', rules).map((x) => x.ruleId)).not.toContain('anchor-furniture');
  });

  it('items marked do-not-use get no care tips', () => {
    const h = emptyHousehold(new Date());
    h.items.push({ id: 'it_h', category: 'high_chair', name: 'high chair', source: 'hand_me_down', doNotUse: true, addedAt: '', status: 'active' });
    expect(findingsFor(h, 'sitting', rules)).toEqual([]);
  });
});
