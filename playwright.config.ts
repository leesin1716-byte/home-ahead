// Playwright 설정: 데모 모드 서버를 띄우고 시뮬레이터 E2E(데모 3막 전체, MCP App 버튼)를 돌린다
import { defineConfig } from '@playwright/test';

const PORT = 8790;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1920, height: 1080 } },
  webServer: {
    command: 'npx tsx src/main.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT), HOME_AHEAD_DEMO: '1', HOME_AHEAD_OFFLINE: '1', HOME_AHEAD_AGENT: 'planner', HOME_AHEAD_VIDEO_SAFE: '1' },
  },
});
