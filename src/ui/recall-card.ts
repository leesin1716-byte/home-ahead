// MCP Apps 뷰: 리콜 카드(중고 판정·리콜 조치·리콜 목록)를 원거리에서 읽히게 그린다
import { esc, startView, type Data } from './common.js';

const VERDICT: Record<string, [string, string]> = {
  do_not_use: ['stop', "Don't use"],
  fix_first: ['fix', 'Fix first'],
  use: ['ok', 'OK to use'],
  need_info: ['info', 'Check the label'],
};

const STOP: Record<string, [string, string]> = {
  yes: ['stop', 'Stop using'],
  if_not_anchored: ['fix', 'Use only if anchored'],
  no: ['info', 'Get the fix'],
};

const STATUS: Record<string, string> = { open: 'Not started', requested: 'Fix requested', resolved: 'Done' };

function recallBlock(r: Data, badge?: [string, string]): string {
  const b = badge ?? STOP[r.stopUsing] ?? STOP.no;
  return `
  <div class="row"><span class="badge ${b[0]}">${esc(b[1])}</span>
    ${r.confidence && r.confidence !== 'confirmed' ? `<span class="badge info">${esc(r.confidence === 'likely' ? 'Likely match' : 'Possible match')}</span>` : ''}
    ${r.remedyStatus && r.remedyStatus !== 'open' ? `<span class="badge ok">${esc(STATUS[r.remedyStatus])}</span>` : ''}</div>
  <div class="kicker" style="margin-top:18px">${esc(r.itemName ? `Your ${r.itemName}${r.room ? ` · ${r.room}` : ''}` : 'Recall')}</div>
  <h1>${esc(r.heading)}</h1>
  <p class="hazard">${esc(r.hazard)}</p>
  ${r.personalNote ? `<p class="note">${esc(r.personalNote)}</p>` : ''}
  <div class="remedy"><span class="kicker">Remedy</span> <strong>${esc(r.remedy)}</strong></div>
  ${r.steps?.length ? `<ul class="steps">${r.steps.slice(0, 3).map((s: string) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
  <div class="src">${esc(r.sourceLabel)} · ${esc(r.monthYear)}${r.units ? ` · ${esc(r.units)} units` : ''}<br><span class="url">${esc(r.urlLabel ?? r.url)}</span></div>`;
}

function render(d: Data) {
  const root = document.getElementById('root')!;
  if (d.error) {
    root.innerHTML = `<div class="card"><span class="badge info">Heads up</span><h1>${esc(d.spoken)}</h1></div>`;
    return;
  }
  // check_secondhand_item
  if (d.verdict) {
    const v = VERDICT[d.verdict] ?? VERDICT.use;
    if (d.recall) {
      root.innerHTML = `<div class="card">${recallBlock(d.recall, v as [string, string])}</div>`;
      return;
    }
    root.innerHTML = `<div class="card"><span class="badge ${v[0]}">${esc(v[1])}</span>
      <div class="kicker" style="margin-top:18px">Hand-me-down check · ${esc(d.item?.name)}</div>
      <h1>${esc(d.verdict === 'need_info' ? d.questions?.[0] : d.verdict === 'use' ? 'No recalls match' : d.reasons?.[0]?.text)}</h1>
      ${d.verdict === 'need_info' ? `<p class="muted">The model number is usually on a sticker under the seat or on the frame.</p>` : ''}
      ${d.reasons?.slice(d.verdict === 'use' ? 0 : 1).map((r: Data) => `<p>${esc(r.text)}</p>`).join('') ?? ''}
      <div class="src">Checked against ${esc(d.noticesSearched)} U.S. CPSC recall notices</div></div>`;
    return;
  }
  // get_recall_guidance
  if (d.recall) {
    root.innerHTML = `<div class="card">${recallBlock(d.recall)}</div>`;
    return;
  }
  // add_items / check_recalls
  const list: Data[] = d.matches ?? d.recalls ?? [];
  if (!list.length) {
    root.innerHTML = `<div class="card"><span class="badge ok">All clear</span><h1>No recalls match your ${esc(d.checkedItems ?? d.added?.length ?? '')} items</h1>
      <div class="src">Checked against ${esc(d.noticesSearched)} U.S. CPSC recall notices</div></div>`;
    return;
  }
  const [first, ...rest] = list;
  root.innerHTML = `<div class="card">${recallBlock(first)}</div>${rest
    .map((r) => `<div class="card mini"><span class="badge ${STOP[r.stopUsing]?.[0] ?? 'info'}">${esc(STOP[r.stopUsing]?.[1] ?? 'Recall')}</span> <strong>${esc(r.itemName)}</strong> · ${esc(r.hazardShort)} · ${esc(r.monthYear)}</div>`)
    .join('')}`;
}

void startView('home-ahead-recall-card', (d) => render(d));
