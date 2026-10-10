// /api/agent 처리: 키가 있으면 Strands 에이전트, 없거나 실패·지연·결제 거절이면 결정적 플래너로 같은 MCP 도구를 부른다
import { appendFileSync } from 'node:fs';
import type { Model } from '@strands-agents/sdk';
import { HomeAheadClient } from './mcp-client.js';
import { Planner, type AgentReply } from './planner.js';
import { modelFromEnv, StrandsAgentRunner, type ModelCall } from './strands.js';

export interface AgentService {
  readonly mode: 'planner' | 'strands';
  modelLabel?: string;
  handle(body: { text?: string; conversationId?: string; reset?: boolean }): Promise<AgentReply | { error: string }>;
  close(): Promise<void>;
}

/** HTTP status of an error or of anything in its cause chain (Strands wraps the SDK's errors). */
function statusOf(err: unknown): number | undefined {
  for (let e = err as { status?: unknown; cause?: unknown } | undefined, i = 0; e && i < 6; e = e.cause as typeof e, i++) {
    if (typeof e.status === 'number') return e.status;
  }
  return undefined;
}

/** A bad or revoked key, no credit or billing, no access, or an unknown model: retrying will not help. */
export function isPermanentModelError(err: unknown): boolean {
  const s = statusOf(err);
  return s === 401 || s === 402 || s === 403 || s === 404;
}

export interface AgentServiceOptions {
  /** Use this model instead of reading the environment (tests). */
  model?: { model: Model; label: string };
  firstToolTimeoutMs?: number;
  turnTimeoutMs?: number;
}

export async function createAgentService(mcpUrl: string, now: () => Date, env: NodeJS.ProcessEnv = process.env, opts: AgentServiceOptions = {}): Promise<AgentService> {
  const client = new HomeAheadClient(mcpUrl);
  await client.connect();
  const planner = new Planner(client, now);
  const picked =
    opts.model ??
    (await modelFromEnv(env).catch((err) => {
      console.warn('[agent] could not load the model provider, using the planner:', err.message);
      return null;
    }));
  // HOME_AHEAD_USAGE_LOG: append the token usage of every model request as one JSON line.
  const usageLog = env.HOME_AHEAD_USAGE_LOG;
  const logUsage = (c: ModelCall) => {
    const usage = { input_tokens: c.inputTokens, output_tokens: c.outputTokens, cache_creation_input_tokens: c.cacheWriteInputTokens, cache_read_input_tokens: c.cacheReadInputTokens };
    appendFileSync(usageLog!, `${JSON.stringify({ at: new Date().toISOString(), model: c.modelId, usage, stopReason: c.stopReason, ms: c.ms })}\n`);
  };
  const strands = picked
    ? new StrandsAgentRunner({
        mcpUrl,
        model: picked.model,
        modelLabel: picked.label,
        now,
        uiFor: (t) => client.tool(t)?.uiResourceUri,
        onModelCall: usageLog ? logUsage : undefined,
        firstToolTimeoutMs: opts.firstToolTimeoutMs,
        turnTimeoutMs: opts.turnTimeoutMs,
      })
    : undefined;
  // Set when the provider turns the key away for good (for example, the credit ran out): from then on
  // the planner answers right away instead of waiting on a request that cannot succeed.
  let modelOff = false;
  const live = () => !!strands && !modelOff;
  // Alerts each conversation has already been told about. The simulator speaks alerts on its own;
  // the model hears about them in its next turn.
  const told = new Map<string, Set<string>>();
  async function announcedSince(id: string): Promise<string[]> {
    const recent = await client.alerts().catch(() => []);
    const seen = told.get(id);
    told.set(id, new Set([...(seen ?? []), ...recent.map((a) => a.id)]));
    // A new conversation starts after the alerts already on file.
    return seen ? recent.filter((a) => !seen.has(a.id)).reverse().map((a) => a.spoken) : [];
  }

  return {
    get mode() {
      return live() ? 'strands' : 'planner';
    },
    modelLabel: picked?.label,
    async handle(body) {
      const id = body.conversationId ?? 'default';
      if (body.reset) {
        planner.reset(id);
        strands?.reset(id);
        told.delete(id);
        return { spoken: '', calls: [], ui: null, mode: live() ? 'strands' : 'planner' };
      }
      const text = (body.text ?? '').slice(0, 500).trim();
      if (!text) return { error: 'text is required' };
      if (strands && live()) {
        try {
          return await strands.handle(text, id, await announcedSince(id));
        } catch (err) {
          if (isPermanentModelError(err)) {
            modelOff = true;
            console.warn(`[agent] The model provider refused the key (HTTP ${statusOf(err)}); the planner answers from now on.`);
          } else {
            console.warn('[agent] Strands call failed, answering with the planner:', (err as Error).message);
          }
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
