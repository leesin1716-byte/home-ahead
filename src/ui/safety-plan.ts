// MCP Apps 뷰: 지금 단계의 방별 안전 계획(전체 화면). 항목을 누르면 update_task 도구로 완료 처리한다
import type { App } from '@modelcontextprotocol/ext-apps';
import { esc, startView, type Data } from './common.js';

let current: Data = {};

function render(d: Data, app: App) {
  current = d;
  const root = document.getElementById('root')!;
  if (d.error) {
    root.innerHTML = `<div class="card"><h1>${esc(d.spoken)}</h1></div>`;
    return;
  }
  const rooms: Data[] = d.rooms ?? [];
  const nick = d.child?.nickname ?? 'Your child';
  root.innerHTML = `
  <header class="head">
    <div><div class="kicker">${d.isPreview ? 'Coming up next' : 'Home check'} · ${esc(nick)}</div>
    <h1>${esc(d.isPreview ? `When ${nick} starts ${d.stageLabel}` : `Ready for ${d.stageLabel}`)}</h1></div>
    <div class="score"><span class="big">${esc(d.openCount)}</span><span class="muted">open</span></div>
  </header>
  <section class="tiles">
    ${rooms
      .flatMap((r) =>
        r.findings.map(
          (f: Data) => `<div class="finding card p${f.priority}">
          <div class="kicker">${esc(r.room)}${f.newThisStage ? ' · <span class="fix">New</span>' : ''}</div>
          <strong class="ft">${esc(f.title)}</strong>
          <div class="muted act">${esc(f.action)}</div>
          <div class="foot"><span class="src">${[...new Set(f.sources.map((s: Data) => String(s.label)))].map(esc).join(' · ')}</span>
          ${d.isPreview ? '' : `<button class="done" data-title="${esc(f.title)}">Mark done</button>`}</div>
        </div>`,
        ),
      )
      .join('')}
    ${!rooms.length ? `<div class="card"><h2>All set</h2><p class="muted">Nothing open for this stage.</p></div>` : ''}
    <aside class="side card">
      <div class="kicker">Done</div>${(d.done ?? []).slice(-3).map((t: Data) => `<div class="doneitem">✓ ${esc(t.title)}</div>`).join('') || '<div class="muted">Nothing yet</div>'}
      <div class="kicker" style="margin-top:14px">Calendar</div>${(d.upcoming ?? []).slice(0, 2).map((t: Data) => `<div><strong>${esc(t.when)}</strong><br><span class="muted">${esc(t.title)}</span></div>`).join('') || '<div class="muted">Nothing scheduled</div>'}
    </aside>
  </section>`;
  root.querySelectorAll<HTMLButtonElement>('button.done').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'Saving…';
      const res = await app.callServerTool({ name: 'update_task', arguments: { task: b.dataset.title, action: 'complete' } });
      if (!res.isError) {
        b.closest('.finding')?.classList.add('is-done');
        b.textContent = 'Done';
        current = { ...current, openCount: Math.max(0, (current.openCount ?? 1) - 1) };
        const score = root.querySelector('.score .big');
        if (score) score.textContent = String(current.openCount);
      } else {
        b.disabled = false;
        b.textContent = 'Try again';
      }
    }),
  );
}

void startView('home-ahead-safety-plan', render);
