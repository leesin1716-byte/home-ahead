// 진입점: 한 프로세스에서 MCP 서버·에이전트 API·Alexa+ 시뮬레이터를 띄운다(npm start)
import { startApp } from './app.js';

// `npm run demo` passes --demo: simulated clock, bundled recall snapshot, no network (works the same on every OS).
const env = process.argv.includes('--demo') ? { ...process.env, HOME_AHEAD_DEMO: '1', HOME_AHEAD_OFFLINE: '1' } : process.env;
const app = await startApp(env);
const { ctx, server, agent } = app;
console.log(`Home Ahead is running.
  Simulator:   ${server.url}/
  MCP server:  ${server.url}/mcp   (Streamable HTTP, protocol 2025-11-25)
  Agent:       ${agent.mode === 'strands' ? `Strands Agents with ${agent.modelLabel}` : 'deterministic planner (no model key set)'}
  Recalls:     ${ctx.index.size} CPSC notices in the local index${ctx.config.offline ? ' (offline mode)' : ''}${ctx.config.demo ? `\n  Demo mode:   on (simulated clock starts ${ctx.clock.now().toISOString().slice(0, 10)}). Scripted demo: ${server.url}/?demo=1` : ''}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
