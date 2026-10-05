// vitest 설정: 단위·MCP 통합 테스트만 돌리고 Playwright E2E는 제외한다
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/mcp/**/*.test.ts'],
    testTimeout: 20000,
  },
});
