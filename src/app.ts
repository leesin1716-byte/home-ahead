// 앱 조립: 컨텍스트·HTTP 서버·에이전트·스케줄러를 만들어 함께 시작하고 함께 닫는다
import { createAgentService, type AgentService } from './agent/api.js';
import { configFromEnv, createContext, type AppConfig, type AppContext } from './context.js';
import { startScheduler } from './server/scheduler.js';
import { startServer, type AppServer } from './server/http.js';

export interface RunningApp {
  ctx: AppContext;
  server: AppServer;
  agent: AgentService;
  close(): Promise<void>;
}

export async function startApp(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): Promise<RunningApp> {
  const config = { ...configFromEnv(env), ...overrides };
  const ctx = createContext(config);
  let agent: AgentService | undefined;
  const server = await startServer(ctx, {
    agent: async (body) => (agent ? agent.handle(body) : { error: 'agent is starting' }),
  });
  // The agent reasons in the household's wall-clock time ("Saturday morning").
  agent = await createAgentService(`${server.url}/mcp`, () => ctx.clock.localNow(), env);
  const stopScheduler = config.demo ? () => {} : startScheduler(ctx);
  const running = agent;
  return {
    ctx,
    server,
    agent: running,
    async close() {
      stopScheduler();
      await running.close();
      await server.close();
    },
  };
}
