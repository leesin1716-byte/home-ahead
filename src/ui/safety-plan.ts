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
  <section class="rooms">
    ${rooms
      .map(
        (r) => `<div class="room card"><h2>${esc(r.room.replace(/^\w/, (c: string) => c.toUpperCase()))}</h2>
      ${r.findings
        .map(
          (f: Data) => `<div class="finding p${f.priority}">
          <div class="row">${f.newThisStage ? '<span class="badge fix">New</span>' : ''}<strong class="ft">${esc(f.title)}</strong></div>
          <div class="muted">${esc(f.action)}</div>
          <div class="src">${f.sources.map((s: Data) => esc(s.label)).join(' · ')}</div>
          ${d.isPreview ? '' : `<button class="done" data-title="${esc(f.title)}">Mark done</button>`}
        </div>`,
        )
        .join('')}</div>`,
      )
      .join('')}
    ${!rooms.length ? `<div class="room card"><h2>All set</h2><p class="muted">Nothing open for this stage.</p></div>` : ''}
    <aside class="side card">
      <h2>Done</h2>${(d.done ?? []).slice(-4).map((t: Data) => `<div class="doneitem">✓ ${esc(t.title)}</div>`).join('') || '<div class="muted">Nothing yet</div>'}
      <h2 style="margin-top:20px">Calendar</h2>${(d.upcoming ?? []).slice(0, 3).map((t: Data) => `<div><strong>${esc(t.when)}</strong><br><span class="muted">${esc(t.title)}</span></div>`).join('') || '<div class="muted">Nothing scheduled</div>'}
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
