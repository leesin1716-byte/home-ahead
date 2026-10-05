// /api/agent 처리: 키가 있으면 Strands 에이전트, 없거나 실패하면 결정적 플래너로 같은 MCP 도구를 부른다
import { HomeAheadClient } from './mcp-client.js';
import { Planner, type AgentReply } from './planner.js';
import { modelFromEnv, StrandsAgentRunner } from './strands.js';

export interface AgentService {
  mode: 'planner' | 'strands';
  modelLabel?: string;
  handle(body: { text?: string; conversationId?: string; reset?: boolean }): Promise<AgentReply | { error: string }>;
  close(): Promise<void>;
}

export async function createAgentService(mcpUrl: string, now: () => Date, env: NodeJS.ProcessEnv = process.env): Promise<AgentService> {
  const client = new HomeAheadClient(mcpUrl);
  await client.connect();
  const planner = new Planner(client, now);
  const picked = await modelFromEnv(env).catch((err) => {
    console.warn('[agent] could not load the model provider, using the planner:', err.message);
    return null;
  });
  const strands = picked
    ? new StrandsAgentRunner({ mcpUrl, model: picked.model, now, uiFor: (t) => client.tool(t)?.uiResourceUri })
    : undefined;

  return {
    mode: strands ? 'strands' : 'planner',
    modelLabel: picked?.label,
    async handle(body) {
      const id = body.conversationId ?? 'default';
      if (body.reset) {
        planner.reset(id);
        strands?.reset(id);
        return { spoken: '', calls: [], ui: null, mode: strands ? 'strands' : 'planner' };
      }
      const text = (body.text ?? '').slice(0, 500).trim();
      if (!text) return { error: 'text is required' };
      if (strands) {
        try {
          return await strands.handle(text, id);
        } catch (err) {
          console.warn('[agent] Strands call failed, answering with the planner:', (err as Error).message);
        }
      }
      return planner.handle(text, id);
    },
    async close() {
      await strands?.close().catch(() => {});
      await client.close().catch(() => {});
    },
  };
}
