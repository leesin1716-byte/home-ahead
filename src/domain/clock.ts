// 시계: 실제 시각 또는 데모용으로 옮길 수 있는 시뮬레이션 시각을 돌려주고, 가구 시간대의 벽시계 시각도 계산한다

/** Throws RangeError for a time zone the runtime does not know. */
export function assertTimeZone(tz: string): string {
  new Intl.DateTimeFormat('en-US', { timeZone: tz });
  return tz;
}

export class Clock {
  private offsetMs = 0;
  private fixed?: number;

  /** IANA time zone of the household. Calendar times ("Saturday at 10 AM") are wall-clock times here. */
  constructor(public timeZone = 'UTC') {
    assertTimeZone(timeZone);
  }

  now(): Date {
    return new Date((this.fixed ?? Date.now()) + this.offsetMs);
  }

  /**
   * The household's wall-clock time as a Date whose UTC fields read as local time
   * (so getUTCDay() is the local weekday). Only for calendar math, never for instants.
   */
  localNow(): Date {
    return toWallClock(this.now(), this.timeZone);
  }

  /** Local wall-clock time as "YYYY-MM-DDTHH:mm", the format tasks are scheduled in. */
  localIso(): string {
    return this.localNow().toISOString().slice(0, 16);
  }

  /** Pin the clock to a moment (demo and tests). */
  set(at: Date | string): void {
    this.fixed = new Date(at).getTime();
    this.offsetMs = 0;
  }

  advanceDays(days: number): void {
    this.offsetMs += days * 24 * 60 * 60 * 1000;
  }

  isSimulated(): boolean {
    return this.fixed !== undefined || this.offsetMs !== 0;
  }

  reset(): void {
    this.fixed = undefined;
    this.offsetMs = 0;
  }
}

export function toWallClock(at: Date, timeZone: string): Date {
  if (timeZone === 'UTC') return new Date(at.getTime());
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return new Date(Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'), at.getUTCMilliseconds()));
}
