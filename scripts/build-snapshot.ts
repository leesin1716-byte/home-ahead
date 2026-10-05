// CPSC Recalls API에서 육아·가구 관련 리콜을 받아 data/cpsc/snapshot.json 으로 저장하는 스크립트
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchRecalls, SNAPSHOT_TERMS } from '../src/cpsc/client.js';
import type { StoredRecall } from '../src/cpsc/normalize.js';

const since = process.argv[2] ?? '2023-01-01';
const out = join(import.meta.dirname, '..', 'data', 'cpsc', 'snapshot.json');

const byNumber = new Map<string, StoredRecall>();
for (const term of SNAPSHOT_TERMS) {
  const recalls = await fetchRecalls({ productName: term, since });
  for (const r of recalls) byNumber.set(r.recallNumber, r);
  console.log(`${term.padEnd(16)} ${String(recalls.length).padStart(4)}  (total ${byNumber.size})`);
}

const recalls = [...byNumber.values()].sort((a, b) =>
  a.recallDate === b.recallDate ? a.recallNumber.localeCompare(b.recallNumber) : a.recallDate < b.recallDate ? 1 : -1,
);
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      source: 'U.S. Consumer Product Safety Commission, Recalls REST API (saferproducts.gov/RestWebServices/Recall)',
      license: 'U.S. federal government work (17 U.S.C. 105). Product images intentionally omitted.',
      fetchedAt: new Date().toISOString(),
      query: { since, terms: SNAPSHOT_TERMS },
      recalls,
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${recalls.length} recalls to ${out}`);
