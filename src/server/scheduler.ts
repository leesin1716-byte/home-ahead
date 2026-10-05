// 주기 새로고침: CPSC에서 새 리콜을 받아 색인에 합치고, 집 물건과 다시 대조해 새 일치는 선제 알림으로 보낸다
import { fetchRecalls, SNAPSHOT_TERMS, type FetchLike } from '../cpsc/client.js';
import type { AppContext } from '../context.js';

export interface RefreshResult {
  fetched: number;
  newRecalls: string[];
  newAlerts: number;
  error?: string;
}

export async function refreshRecalls(ctx: AppContext, fetchImpl?: FetchLike): Promise<RefreshResult> {
  let fetched = 0;
  let newRecalls: string[] = [];
  let error: string | undefined;
  if (!ctx.config.offline) {
    // Start a week before the newest notice we hold: CPSC sometimes backfills.
    const newest = ctx.index.newestDate() ?? '2023-01-01';
    const since = new Date(new Date(`${newest}T00:00:00Z`).getTime() - 7 * 864e5).toISOString().slice(0, 10);
    try {
      for (const term of SNAPSHOT_TERMS) {
        const recs = await fetchRecalls({ productName: term, since, fetchImpl, timeoutMs: 20_000 });
        fetched += recs.length;
        newRecalls.push(...ctx.index.merge(recs));
      }
      ctx.index.lastRefreshAt = new Date().toISOString();
    } catch (err) {
      error = (err as Error).message;
    }
    newRecalls = [...new Set(newRecalls)];
  }
  const swept = ctx.service.sweep(true);
  return { fetched, newRecalls, newAlerts: swept.alerts.length, error };
}

export function startScheduler(ctx: AppContext): () => void {
  if (!ctx.config.refreshMinutes) return () => {};
  const run = () =>
    refreshRecalls(ctx).then((r) => {
      if (r.error) console.warn(`[scheduler] CPSC refresh failed (${r.error}); using the local snapshot.`);
      else console.log(`[scheduler] CPSC refresh: ${r.newRecalls.length} new notices, ${r.newAlerts} new alerts.`);
    });
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, ctx.config.refreshMinutes * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
