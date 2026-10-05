// 집 안 물건과 CPSC 리콜을 대조해 신뢰도(확정/가능성 높음/가능성 있음)를 매기는 규칙
import { brandMatches, normalizeModel, type RecallRecord } from '../cpsc/normalize.js';
import type { Confidence, Item } from './types.js';

export interface RecallHit {
  recall: RecallRecord;
  confidence: Confidence;
  reasons: string[];
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { confirmed: 0, likely: 1, possible: 2 };

function modelMatches(itemModel: string, rec: RecallRecord): boolean {
  const m = normalizeModel(itemModel);
  if (m.length < 3) return false;
  if (rec.models.some((r) => r === m || (m.length >= 5 && r.length >= 5 && (r.includes(m) || m.includes(r))))) return true;
  // Some notices print the code in a form our extractor misses; fall back to the raw text.
  return normalizeModel(rec.description).includes(m) && m.length >= 5;
}

/**
 * - confirmed: the model number on the item's label is in the notice and the product type agrees.
 * - likely: the model matches but the product type is unclear, or the brand and type match and
 *   the notice names no model numbers.
 * - possible: the brand and type match, the notice lists model numbers, and we don't know the item's.
 * A known model that is not in the notice is not a match.
 */
export function matchItem(item: Item, rec: RecallRecord): RecallHit | null {
  const categoryOk = rec.categories.includes(item.category);
  const brandOk = item.brand ? brandMatches(item.brand, rec) : undefined;
  if (item.model) {
    if (modelMatches(item.model, rec)) {
      if (brandOk === false && !categoryOk) return null;
      return categoryOk
        ? { recall: rec, confidence: 'confirmed', reasons: ['model number', 'product type'] }
        : { recall: rec, confidence: 'likely', reasons: ['model number'] };
    }
    if (rec.models.length > 0) return null;
  }
  if (brandOk && categoryOk) {
    return rec.models.length === 0
      ? { recall: rec, confidence: 'likely', reasons: ['brand', 'product type'] }
      : { recall: rec, confidence: 'possible', reasons: ['brand', 'product type'] };
  }
  return null;
}

export function findRecallHits(item: Item, records: Iterable<RecallRecord>): RecallHit[] {
  const hits: RecallHit[] = [];
  for (const rec of records) {
    const hit = matchItem(item, rec);
    if (hit) hits.push(hit);
  }
  return hits.sort(
    (a, b) =>
      CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
      (a.recall.recallDate < b.recall.recallDate ? 1 : -1),
  );
}

/** Whether any visible recall exists for this kind of product (so a model number is worth asking for). */
export function categoryHasRecalls(category: Item['category'], records: Iterable<RecallRecord>): boolean {
  for (const r of records) if (r.categories.includes(category)) return true;
  return false;
}
