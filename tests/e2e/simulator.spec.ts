// 시뮬레이터 E2E: 브라우저에서 데모 3막을 끝까지 재생하고, MCP App 안의 버튼이 MCP 도구를 부르는지 확인한다
import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page, query = '') {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => (window as any).__homeAhead?.ready === true);
}

test('the three-act demo plays to the end in the simulator', async ({ page }) => {
  await ready(page, '?demo=1&speed=12&tts=0');
  await page.waitForFunction(() => (window as any).__homeAhead.done === true, null, { timeout: 150_000 });
  const events = await page.evaluate(() => (window as any).__homeAhead.events as { type: string; id?: string; text?: string }[]);
  const said = events.filter((e) => e.type === 'assistant').map((e) => e.text ?? '');
  expect(said.some((t) => /don't use that high chair/.test(t))).toBe(true);
  expect(said.some((t) => /bumpers are banned/.test(t))).toBe(true);
  expect(said.some((t) => /Order placed/.test(t))).toBe(true);
  expect(events.some((e) => e.type === 'alert' && /dresser/.test(e.text ?? ''))).toBe(true);
  expect(said.some((t) => /free repair kit/.test(t))).toBe(true);
  // The inspector is open at the end and shows real tool calls.
  await expect(page.locator('#inspector')).toBeVisible();
  await expect(page.locator('#calls li').first()).toContainText('tools/call');
  await expect(page.locator('#proto')).toContainText('2025-11-25');
  // Video-safe mode keeps the recalled brand off the screen.
  const shown = await page.locator('#app-slot iframe').contentFrame().locator('body').innerText().catch(() => '');
  expect(shown).not.toMatch(/Aitjunz|Yuyitop|Bicystar/);
});

test('an MCP App view calls a tool through the host (cart "Place order")', async ({ page }) => {
  await page.request.post('/api/demo/reset');
  await ready(page, '?tts=0');
  await page.request.post('/api/demo/advance', { data: { days: 21 } });
  await page.evaluate(async () => {
    await (window as any).__homeAhead.ask('She pulled herself up on the couch today!');
    await (window as any).__homeAhead.ask('Get the supplies');
  });
  const view = page.locator('#app-slot iframe').contentFrame();
  await expect(view.locator('text=Demo store · no real purchase')).toBeVisible();
  await view.locator('#confirm').click();
  await expect(view.locator('text=Order placed')).toBeVisible();
  await expect(page.locator('#calls li .src', { hasText: 'called from the MCP App view' })).toHaveCount(1);
});

test('the recall card renders from the tool result inside the sandboxed view', async ({ page }) => {
  await page.request.post('/api/demo/reset');
  await ready(page, '?tts=0');
  await page.evaluate(async () => {
    await (window as any).__homeAhead.ask('A friend gave us a used high chair, model TB-HC6900.');
  });
  const view = page.locator('#app-slot iframe').contentFrame();
  await expect(view.locator('h1')).toHaveText('High chair recall');
  await expect(view.locator('.badge').first()).toHaveText("Don't use");
  await expect(view.locator('.src')).toContainText('U.S. CPSC recall 26290');
  // The view finished ui/initialize, so its size-changed notices reach the host and the frame grows to fit.
  await expect.poll(() => page.locator('#app-slot iframe').evaluate((f) => f.getBoundingClientRect().height)).toBeGreaterThan(500);
  // The host enforces the view's declared CSP: no network access from inside the view.
  const srcdoc = await page.locator('#app-slot iframe').getAttribute('srcdoc');
  expect(srcdoc).toContain(`http-equiv="Content-Security-Policy"`);
  expect(srcdoc).toContain("connect-src 'none'");
  // no-cors would succeed (opaque response) from a sandboxed frame without the CSP; with it, the request never leaves.
  const target = new URL('/api/health', page.url()).href;
  const blocked = await view.locator('body').evaluate((_, u) => fetch(u, { mode: 'no-cors' }).then(() => 'allowed', () => 'blocked'), target);
  expect(blocked).toBe('blocked');
});

test('a proactive recall alert names the CPSC recall it comes from', async ({ page }) => {
  await page.request.post('/api/demo/reset');
  await ready(page, '?tts=0');
  await page.request.post('/api/demo/advance', { data: { days: 28 } });
  await expect(page.locator('#alert-card')).toBeVisible();
  await expect(page.locator('#alert-card .src')).toHaveText('U.S. CPSC recall 26794');
});

for (const [cut, query] of [['demo', ''], ['live-model cut (inspector open throughout)', '&script=live']]) test(`on-screen text never sits under the app view or the alert card during the ${cut}`, async ({ page }) => {
  await ready(page, `?demo=1&speed=12&tts=0${query}`);
  // Sample the layout while the demo plays: the spoken line and the reply must stay clear of the right-hand panels.
  await page.evaluate(() => {
    const hits: string[] = [];
    (window as any).__overlaps = hits;
    const shown = (el: HTMLElement | null) => !!el && !el.hidden && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
    const meet = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    setInterval(() => {
      const screen = document.getElementById('screen')!;
      if (screen.dataset.ui === 'fullscreen') return;
      const texts = ['user-bubble', 'reply'].map((id) => document.getElementById(id)).filter(shown) as HTMLElement[];
      const panels = ['app-slot', 'alert-card'].map((id) => document.getElementById(id)).filter(shown) as HTMLElement[];
      for (const t of texts)
        for (const p of panels)
          if (meet(t.getBoundingClientRect(), p.getBoundingClientRect())) hits.push(`${t.id} under ${p.id}: ${t.innerText.slice(0, 40)}`);
    }, 50);
  });
  await page.waitForFunction(() => (window as any).__homeAhead.done === true, null, { timeout: 150_000 });
  const hits = await page.evaluate(() => [...new Set((window as any).__overlaps as string[])]);
  expect(hits).toEqual([]);
});

test('a Strands reply shows the model and its token use without crowding the top bar', async ({ page }) => {
  await page.request.post('/api/demo/reset');
  // Stand in for a live model so this runs without a key.
  await page.route('**/api/agent', (route) =>
    route.fulfill({
      json: {
        spoken: 'I can check both. What model numbers are on their labels?',
        calls: [],
        ui: null,
        mode: 'strands',
        model: 'Claude claude-opus-5-5',
        usage: { modelCalls: 2, inputTokens: 6, outputTokens: 275, cacheReadInputTokens: 6628, cacheWriteInputTokens: 345, modelMs: 4361 },
        protocolVersion: '2025-11-25',
      },
    }),
  );
  await ready(page, '?tts=0');
  await page.evaluate(async () => {
    await (window as any).__homeAhead.ask('My sister is giving us her old high chair and crib.');
  });
  await expect(page.locator('#mode-badge')).toHaveText('Strands agent · Claude claude-opus-5-5 · MCP 2025-11-25');
  await page.locator('#inspector-toggle').click();
  const turn = page.locator('#calls li.turn');
  await expect(turn).toContainText('model claude-opus-5-5');
  await expect(turn).toContainText('2 requests · 6,979 tokens in (6,628 cached) · 275 out');
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const [brand, status, stage] = [await box('.brand'), await box('.status'), await box('#stage')];
  expect(brand.x + brand.width).toBeLessThan(status.x);
  expect(status.x + status.width).toBeLessThanOrEqual(stage.x + stage.width);
});
