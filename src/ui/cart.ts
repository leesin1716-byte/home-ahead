// MCP Apps 뷰: 안전용품 장바구니 확인 카드. 버튼은 confirm_supply_order 도구를 확인 토큰과 함께 부른다
import type { App } from '@modelcontextprotocol/ext-apps';
import { esc, startView, type Data } from './common.js';

function money(n: number) {
  return `$${Number(n).toFixed(2)}`;
}

function render(d: Data, app: App) {
  const root = document.getElementById('root')!;
  const o = d.order;
  if (!o) {
    root.innerHTML = `<div class="card"><h1>${esc(d.spoken ?? 'Nothing to order')}</h1></div>`;
    return;
  }
  const confirmed = o.status === 'confirmed';
  root.innerHTML = `<div class="card">
    <div class="row"><span class="badge ${confirmed ? 'ok' : 'info'}">${confirmed ? 'Order placed' : 'Confirm order'}</span><span class="muted">Demo store · no real purchase</span></div>
    <table class="lines">${o.lines
      .map((l: Data) => `<tr><td class="qty">${esc(l.qty)}×</td><td>${esc(l.name)}</td><td class="price">${money(l.qty * l.unitPrice)}</td></tr>`)
      .join('')}
      <tr class="total"><td></td><td>Total</td><td class="price">${money(o.total)}</td></tr></table>
    <div class="row">${confirmed ? '<span class="ok big">✓ Ordered</span>' : `<button id="confirm">Place order</button><span class="muted">or say “yes”</span>`}</div>
  </div>`;
  const btn = root.querySelector<HTMLButtonElement>('#confirm');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Placing…';
    const res = await app.callServerTool({ name: 'confirm_supply_order', arguments: { token: o.token } });
    render((res.structuredContent ?? {}) as Data, app);
  });
}

void startView('home-ahead-cart', render);
