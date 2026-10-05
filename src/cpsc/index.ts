// 로컬 리콜 색인: 스냅샷을 읽고, 새로고침 결과를 합치고, 시뮬레이션 시계 기준으로 「공개된」 리콜만 보여 준다
import { readFileSync } from 'node:fs';
import { buildGenericVocabulary, brandWords, deriveRecord, type RecallRecord, type StoredRecall } from './normalize.js';

export class RecallIndex {
  private byNumber = new Map<string, RecallRecord>();
  private vocab: Set<string>;
  private brandCache = new Map<string, string[]>();
  /** Records added after the snapshot (live refreshes), kept so they can be saved and survive a restart. */
  private live = new Map<string, StoredRecall>();
  lastRefreshAt?: string;

  constructor(stored: StoredRecall[]) {
    for (const s of stored) this.byNumber.set(s.recallNumber, deriveRecord(s));
    this.vocab = buildGenericVocabulary(stored);
  }

  static fromSnapshotFile(path: string): RecallIndex {
    const snap = JSON.parse(readFileSync(path, 'utf8')) as { recalls: StoredRecall[] };
    return new RecallIndex(snap.recalls);
  }

  get size(): number {
    return this.byNumber.size;
  }

  get(recallNumber: string): RecallRecord | undefined {
    return this.byNumber.get(recallNumber);
  }

  /** Recalls published on or before `asOf`. The demo moves a simulated clock; real use passes now. */
  visible(asOf: Date): RecallRecord[] {
    const day = asOf.toISOString().slice(0, 10);
    return [...this.byNumber.values()].filter((r) => r.recallDate <= day);
  }

  /** Newest recall date we hold, used as the start of the next live fetch. */
  newestDate(): string | undefined {
    let max: string | undefined;
    for (const r of this.byNumber.values()) if (!max || r.recallDate > max) max = r.recallDate;
    return max;
  }

  /** Add or replace records; returns the recall numbers that were new. */
  merge(stored: StoredRecall[]): string[] {
    const added: string[] = [];
    for (const s of stored) {
      if (!this.byNumber.has(s.recallNumber)) added.push(s.recallNumber);
      this.byNumber.set(s.recallNumber, deriveRecord(s));
      this.brandCache.delete(s.recallNumber);
      this.live.set(s.recallNumber, s);
    }
    return added;
  }

  /** Everything merged since the snapshot was loaded. */
  liveRecords(): StoredRecall[] {
    return [...this.live.values()];
  }

  brandWordsFor(rec: RecallRecord): string[] {
    let words = this.brandCache.get(rec.recallNumber);
    if (!words) {
      words = brandWords(rec, this.vocab);
      this.brandCache.set(rec.recallNumber, words);
    }
    return words;
  }
}
