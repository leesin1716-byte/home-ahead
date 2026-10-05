// 리콜 정규화(모델·분류·브랜드 추출)와 물건-리콜 대조 신뢰도 규칙을 실제 스냅샷 레코드로 검사한다
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { RecallIndex } from '../../src/cpsc/index.js';
import { fetchRecalls } from '../../src/cpsc/client.js';
import { brandMatches, extractModels, normalizeModel, trimApiRecall } from '../../src/cpsc/normalize.js';
import { matchItem, findRecallHits } from '../../src/domain/matching.js';
import { detectCategories, detectCategory } from '../../src/domain/categories.js';
import type { Item } from '../../src/domain/types.js';

const index = RecallIndex.fromSnapshotFile(join(import.meta.dirname, '..', '..', 'data', 'cpsc', 'snapshot.json'));
const rec = (n: string) => index.get(n)!;
const item = (over: Partial<Item>): Item => ({
  id: 'it_x',
  category: 'other',
  name: 'thing',
  source: 'owned',
  addedAt: '2026-01-01T00:00:00Z',
  status: 'active',
  ...over,
});

describe('normalize', () => {
  it('pulls model numbers out of the different ways CPSC writes them', () => {
    expect(rec('26290').models).toContain('TBHC6900'); // Model No.: TB-HC6900
    expect(rec('26794').models).toEqual(expect.arrayContaining(['LDQMFJ8DWH', 'LDQMFJ8DBK'])); // SKU “…”
    expect(rec('26264').models).toEqual(expect.arrayContaining(['YJ3355', 'YJ33110'])); // (model YJ-3355)
    expect(rec('26121').models).toContain('HA028'); // Product No.: HA-028
  });

  it('does not treat measurements as model numbers', () => {
    expect(rec('26794').models.some((m) => /^\d+IN/.test(m))).toBe(false);
    expect(extractModels({ ...rec('26794'), description: 'They measure 15.55 inches wide and weigh 129 pounds.', products: [] })).toEqual([]);
  });

  it('files recalls under the right product type, most specific first', () => {
    expect(rec('26169').categories[0]).toBe('crib_bumper');
    expect(rec('26541').categories).toContain('dresser'); // "Changing Table Dressers"
    expect(detectCategory('an old high chair')).toBe('high_chair');
    expect(detectCategory('a crib mattress')).toBe('crib_mattress');
    expect(detectCategories('magnetic building cubes')).toContain('magnetic_toy');
    expect(detectCategory('a skywalker set')).toBeUndefined();
  });

  it('matches brands on whole words only', () => {
    expect(brandMatches('Bicystar', rec('26290'))).toBe(true);
    expect(brandMatches('Bicy', rec('26290'))).toBe(false);
    expect(normalizeModel('ldqmfj8d-wh')).toBe('LDQMFJ8DWH');
  });

  it('keeps product photos out of stored records', () => {
    const stored = trimApiRecall({ RecallID: 1, RecallNumber: '1', RecallDate: '2026-01-01T00:00:00', Title: 't', Description: 'd', URL: 'u', Images: [{ URL: 'x' }] } as never);
    expect(JSON.stringify(stored)).not.toContain('Images');
  });
});

describe('matching confidence', () => {
  it('confirmed: model and product type agree', () => {
    expect(matchItem(item({ category: 'high_chair', model: 'tb-hc6900' }), rec('26290'))?.confidence).toBe('confirmed');
  });
  it('likely: model agrees but the type is unknown', () => {
    expect(matchItem(item({ category: 'other', model: 'TB-HC6900' }), rec('26290'))?.confidence).toBe('likely');
  });
  it('possible: brand and type agree but we lack the model', () => {
    expect(matchItem(item({ category: 'high_chair', brand: 'Bicystar' }), rec('26290'))?.confidence).toBe('possible');
  });
  it('no match when the label model differs from the notice', () => {
    expect(matchItem(item({ category: 'high_chair', brand: 'Bicystar', model: 'TB-HC1000' }), rec('26290'))).toBeNull();
  });
  it('no match on product type alone', () => {
    expect(findRecallHits(item({ category: 'dresser' }), index.visible(new Date('2026-10-06')))).toEqual([]);
  });
});

describe('index', () => {
  it('only shows recalls published by the (simulated) date', () => {
    expect(index.visible(new Date('2026-09-23T12:00:00Z')).some((r) => r.recallNumber === '26794')).toBe(false);
    expect(index.visible(new Date('2026-09-24T12:00:00Z')).some((r) => r.recallNumber === '26794')).toBe(true);
  });

  it('merges a refresh and reports only new recall numbers', () => {
    const idx = new RecallIndex([trimApiRecall({ RecallID: 1, RecallNumber: 'A1', RecallDate: '2026-01-01T00:00:00', Title: 'X Cribs Recalled', Description: '', URL: '' })]);
    const added = idx.merge([
      trimApiRecall({ RecallID: 1, RecallNumber: 'A1', RecallDate: '2026-01-01T00:00:00', Title: 'X Cribs Recalled', Description: '', URL: '' }),
      trimApiRecall({ RecallID: 2, RecallNumber: 'B2', RecallDate: '2026-02-01T00:00:00', Title: 'Y Gates Recalled', Description: '', URL: '' }),
    ]);
    expect(added).toEqual(['B2']);
    expect(idx.newestDate()).toBe('2026-02-01');
  });
});

describe('CPSC client (recorded response, no network)', () => {
  it('builds the query and trims the response', async () => {
    let called = '';
    const recorded = [{ RecallID: 10633, RecallNumber: '26290', RecallDate: '2026-02-26T00:00:00', Title: 'High Chairs Recalled', Description: 'Model No.: TB-HC6900', URL: 'https://www.cpsc.gov/x', Images: [{ URL: 'img' }] }];
    const out = await fetchRecalls({
      productName: 'high chair',
      since: '2026-01-01',
      fetchImpl: async (u) => {
        called = u;
        return { ok: true, status: 200, json: async () => recorded };
      },
    });
    expect(called).toContain('ProductName=high+chair');
    expect(called).toContain('RecallDateStart=2026-01-01');
    expect(out[0].recallNumber).toBe('26290');
  });

  it('throws a clear error on HTTP failure', async () => {
    await expect(fetchRecalls({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => null }) })).rejects.toThrow('HTTP 503');
  });
});
