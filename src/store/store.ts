// 가구 상태를 JSON 파일 하나에 저장한다. 임시 파일에 쓴 뒤 rename 해서 쓰기 도중 죽어도 파일이 깨지지 않는다
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Household } from '../domain/types.js';

export function emptyHousehold(now: Date): Household {
  return {
    id: 'home',
    rooms: [],
    children: [],
    items: [],
    recallMatches: [],
    tasks: [],
    orders: [],
    alerts: [],
    updatedAt: now.toISOString(),
  };
}

export class HouseholdStore {
  private cache: Household | undefined;

  /** `file` null keeps everything in memory (tests). */
  constructor(
    private readonly file: string | null,
    private readonly initial: () => Household,
  ) {}

  load(): Household {
    if (this.cache) return this.cache;
    if (this.file && existsSync(this.file)) {
      this.cache = JSON.parse(readFileSync(this.file, 'utf8')) as Household;
    } else {
      this.cache = this.initial();
    }
    return this.cache;
  }

  save(h: Household): void {
    this.cache = h;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(h, null, 2));
    renameSync(tmp, this.file);
  }

  /** Apply a change and persist it; the callback mutates the household in place. */
  update<T>(fn: (h: Household) => T): T {
    const h = structuredClone(this.load());
    const result = fn(h);
    this.save(h);
    return result;
  }

  replace(h: Household): void {
    this.save(structuredClone(h));
  }
}
