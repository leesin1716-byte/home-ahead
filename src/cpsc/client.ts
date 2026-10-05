// CPSC Recalls REST API 실호출 클라이언트(키 불필요). 도구 응답 경로에서는 부르지 않고 새로고침에만 쓴다
import { trimApiRecall, type CpscApiRecall, type StoredRecall } from './normalize.js';

export const CPSC_ENDPOINT = 'https://www.saferproducts.gov/RestWebServices/Recall';

/** Product-name searches that cover nursery products and tip-over furniture. */
export const SNAPSHOT_TERMS = [
  'crib',
  'bassinet',
  'high chair',
  'stroller',
  'dresser',
  'chest',
  'drawer',
  'play yard',
  'gate',
  'bath seat',
  'baby bath',
  'swing',
  'rocker',
  'sleeper',
  'bunk bed',
  'blinds',
  'shade',
  'baby monitor',
  'walker',
  'nursing pillow',
  'lounger',
  'changing table',
  'booster seat',
  'sling',
  'teether',
  'magnet',
  'bookcase',
  'bed rail',
  'pacifier',
  'television',
  'night light',
  'infant',
];

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FetchRecallsOptions {
  productName?: string;
  since?: string; // YYYY-MM-DD
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function fetchRecalls(opts: FetchRecallsOptions): Promise<StoredRecall[]> {
  const url = new URL(CPSC_ENDPOINT);
  url.searchParams.set('format', 'json');
  if (opts.productName) url.searchParams.set('ProductName', opts.productName);
  if (opts.since) url.searchParams.set('RecallDateStart', opts.since);
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  if (!res.ok) throw new Error(`CPSC API returned HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('CPSC API returned an unexpected body');
  return (body as CpscApiRecall[]).map(trimApiRecall);
}
