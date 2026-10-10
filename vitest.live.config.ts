// vitest 실호출 설정: tests/live 만 돌린다(npm run test:live, .env 의 ANTHROPIC_API_KEY 필요·과금)
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
  },
});
