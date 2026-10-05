// MCP Apps 뷰 공통부: 호스트 연결, 테마 적용, HTML 이스케이프, 원거리 가독용 기본 스타일
import { App } from '@modelcontextprotocol/ext-apps';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type Data = Record<string, any>;

function applyHostContext(ctx: Record<string, any> | undefined) {
  if (!ctx) return;
  const root = document.documentElement;
  if (ctx.theme) root.dataset.theme = ctx.theme;
  if (ctx.displayMode) root.dataset.mode = ctx.displayMode;
  if (ctx.deviceClass) root.dataset.device = ctx.deviceClass;
  const inset = ctx.safeAreaInsets;
  if (inset) root.style.setProperty('--safe', `${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px`);
}

/** Connect to the host, then render every tool result (and re-render after our own tool calls). */
export async function startView(name: string, render: (data: Data, app: App) => void): Promise<App> {
  const app = new App({ name, version: '0.1.0' }, {}, { autoResize: true });
  app.ontoolresult = (p) => {
    const data = (p.structuredContent ?? {}) as Data;
    document.body.classList.toggle('is-error', !!p.isError);
    render(data, app);
  };
  app.onhostcontextchanged = (ctx) => applyHostContext(ctx as Record<string, any>);
  await app.connect();
  applyHostContext(app.getHostContext() as Record<string, any>);
  return app;
}

export const BASE_CSS = `
:root{--bg:#0f1b24;--card:#172733;--line:#26394a;--text:#f2f5f7;--muted:#a3b3bf;--stop:#ff7a6b;--fix:#ffc15e;--ok:#6fdc9a;--accent:#7cc7ff;--safe:0px;
  --t1:44px;--t2:28px;--t3:22px;--t4:18px;color-scheme:dark}
:root[data-theme="light"]{--bg:#f6f4ef;--card:#ffffff;--line:#e2ddd2;--text:#1d2830;--muted:#5b6872;--stop:#c23b2c;--fix:#a86400;--ok:#1f8a4c;--accent:#1f6fb2;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--text);font:400 var(--t3)/1.35 "Atkinson Hyperlegible","Segoe UI",system-ui,-apple-system,sans-serif}
body{padding:var(--safe)}
.card{background:var(--card);border:1px solid var(--line);border-radius:28px;padding:28px 32px}
.kicker{font-size:var(--t4);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:700}
h1{font-size:var(--t1);line-height:1.1;margin:.2em 0 .25em;font-weight:800;letter-spacing:-.01em}
h2{font-size:var(--t2);margin:0 0 .3em}
.muted{color:var(--muted)}
.badge{display:inline-flex;align-items:center;gap:.4em;font-weight:800;font-size:var(--t4);letter-spacing:.06em;text-transform:uppercase;padding:.35em .8em;border-radius:999px;border:2px solid currentColor}
.stop{color:var(--stop)}.fix{color:var(--fix)}.ok{color:var(--ok)}.info{color:var(--accent)}
button{font:inherit;font-weight:700;font-size:var(--t3);border-radius:999px;border:0;padding:.7em 1.4em;background:var(--accent);color:#06131c;cursor:pointer}
button[disabled]{opacity:.55;cursor:default}
.src{font-size:var(--t4);color:var(--muted);margin-top:18px}
ul.steps{margin:.4em 0 0;padding-left:1.1em}ul.steps li{margin:.2em 0}
.row{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
`;
