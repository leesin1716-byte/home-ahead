// MCP Apps UI 3종과 시뮬레이터 스크립트를 esbuild 로 묶는다. UI는 자체 완결 HTML 하나에 콘텐츠 해시를 붙인 ui:// 이름을 쓴다
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { build } from 'esbuild';
import { BASE_CSS } from '../ui/common.js';

const SRC = join(import.meta.dirname, '..');

export interface UiView {
  key: 'recall-card' | 'safety-plan' | 'cart';
  title: string;
  uri: string;
  html: string;
}

const VIEW_CSS: Record<UiView['key'], string> = {
  'recall-card': `
.card+.card{margin-top:14px}.hazard{font-size:26px;line-height:1.3;margin:.2em 0 .5em}ul.steps{font-size:20px}
.note{font-size:var(--t3);border-left:6px solid var(--fix);padding:.3em .8em;margin:.6em 0;background:color-mix(in srgb,var(--fix) 10%,transparent);border-radius:0 12px 12px 0}
.remedy{margin-top:10px;font-size:var(--t2)}.url{word-break:break-all}
.mini{padding:16px 24px;font-size:var(--t3)}`,
  'safety-plan': `
body{padding:28px}.head{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px}
.score{text-align:right}.score .big{display:block;font-size:72px;font-weight:800;line-height:1}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;align-items:stretch}
.card.finding,.card.side{padding:20px 24px;border-radius:24px;display:flex;flex-direction:column;gap:6px}
.finding .ft{font-size:25px;line-height:1.2}.finding.p1 .ft::before{content:"";display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--stop);margin-right:10px;vertical-align:middle}
.finding .act{font-size:20px;line-height:1.3}
.foot{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:auto;padding-top:8px}.foot .src{margin-top:0;font-size:16px}
.finding button{flex:none;font-size:var(--t4);padding:.45em 1em}
.finding.is-done{opacity:.55}.finding.is-done .ft{text-decoration:line-through}
.doneitem{color:var(--ok);margin:.15em 0}`,
  cart: `
.lines{width:100%;border-collapse:collapse;margin:20px 0;font-size:var(--t2)}
.lines td{padding:.45em 0;border-bottom:1px solid var(--line)}.qty{width:3.2em;color:var(--muted)}.price{text-align:right;white-space:nowrap}
.total td{border-bottom:0;font-weight:800}.big{font-size:var(--t2);font-weight:800}`,
};

const TITLES: Record<UiView['key'], string> = {
  'recall-card': 'Recall card',
  'safety-plan': 'Room-by-room safety plan',
  cart: 'Safety supplies cart',
};

async function bundle(entry: string): Promise<string> {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
  return out.outputFiles[0].text;
}

/** Build the three MCP Apps views. Each is one self-contained HTML file (no network access needed). */
export async function buildUiViews(): Promise<Record<UiView['key'], UiView>> {
  const keys = Object.keys(VIEW_CSS) as UiView['key'][];
  const views = await Promise.all(
    keys.map(async (key) => {
      const js = (await bundle(join(SRC, 'ui', `${key}.ts`))).replace(/<\/script/gi, '<\\/script');
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${TITLES[key]}</title><style>${BASE_CSS}${VIEW_CSS[key]}</style></head><body><main id="root"></main><script>${js}</script></body></html>`;
      const hash = createHash('sha256').update(html).digest('hex').slice(0, 8);
      return { key, title: TITLES[key], uri: `ui://home-ahead/${key}-${hash}.html`, html };
    }),
  );
  return Object.fromEntries(views.map((v) => [v.key, v])) as Record<UiView['key'], UiView>;
}

/** Bundle the simulator's browser code. */
export async function buildSimulatorScript(): Promise<string> {
  return bundle(join(SRC, 'sim', 'app.ts'));
}
