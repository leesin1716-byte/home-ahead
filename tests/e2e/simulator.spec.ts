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
});
