// 시계: 실제 시각 또는 데모용으로 옮길 수 있는 시뮬레이션 시각을 돌려준다

export class Clock {
  private offsetMs = 0;
  private fixed?: number;

  now(): Date {
    return new Date((this.fixed ?? Date.now()) + this.offsetMs);
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
