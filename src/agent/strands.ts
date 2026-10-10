// Strands Agents 경로: 모델 키가 있으면 Strands 에이전트가 MCP 클라이언트(SDK v1)로 같은 서버의 도구를 고른다
import { Agent, McpClient, NullConversationManager, type Model } from '@strands-agents/sdk';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCallRecord } from './mcp-client.js';
import type { AgentReply, TurnUsage, UiRef } from './planner.js';

export const SYSTEM_PROMPT = `You are Home Ahead, an add-on for a voice assistant on a kitchen smart display.
You help a family keep their home safe as their baby grows, using the Home Ahead tools.
- Use a tool for anything about the child's stage, items in the home, hand-me-downs, recalls, the safety plan, supplies or tasks.
- Each tool result has a "spoken" field. Reply with that text, lightly joined if you called more than one tool. Keep replies under 40 words; the screen shows the details.
- Your whole reply is read aloud to the family as written: only the words to say, in plain sentences, with no notes about your reply, markdown, lists or headings.
- Never read out URLs, IDs, JSON or tool names.
- Never call confirm_supply_order unless the user has just clearly said yes to the cart you prepared.
- When a tool asks a question (for example a model number), ask it and wait for the answer.
- Each user message starts with the local date and time at home in square brackets. Times you pass to update_task are local wall-clock times; never schedule anything in the past.
- If alerts were announced on the display since the last turn, they follow the time in parentheses; the user may be answering them.`;

/** "Friday, September 18, 2026, 6:30 PM" from a wall-clock Date (UTC fields hold local time). */
export function describeNow(localNow: Date): string {
  return localNow.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
}

/**
 * The user's words with the household's wall-clock time in front. The time rides in the user turn
 * instead of the system prompt so the prompt and earlier turns stay byte-identical: that keeps the
 * prompt cache warm, and Claude rejects replayed thinking blocks once anything before them changes.
 */
export function userTurn(text: string, localNow: Date, announced: string[] = []): string {
  const note = announced.length ? ` (Announced on the display since the last turn: ${announced.map((a) => `"${a}"`).join(' ')})` : '';
  return `[${describeNow(localNow)}]${note} ${text}`;
}

/** Token usage of one model request. */
export interface ModelCall {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  stopReason?: string;
  ms: number;
}

/** Reports the usage of every request the model makes (Strands keeps it per agent, not per turn). */
function meter(model: Model, onCall: (c: ModelCall) => void) {
  const inner = model.stream.bind(model);
  const modelId = String(model.getConfig().modelId ?? 'unknown');
  model.stream = async function* (...args: Parameters<Model['stream']>) {
    const t0 = performance.now();
    let usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } | undefined;
    let stopReason: string | undefined;
    try {
      for await (const ev of inner(...args)) {
        if (ev.type === 'modelMetadataEvent' && ev.usage) usage = ev.usage;
        if (ev.type === 'modelMessageStopEvent') stopReason = ev.stopReason;
        yield ev;
      }
    } finally {
      if (usage) {
        onCall({
          modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
          stopReason,
          ms: Math.round(performance.now() - t0),
        });
      }
    }
  } as Model['stream'];
}

/** Thrown when the model did not reach a tool in time; nothing ran, so the planner can answer. */
export class ModelTimeoutError extends Error {}

/**
 * Wraps the v1 client transport and records every tools/call round trip. Strands keeps only the
 * text content of MCP results, but the simulator needs structuredContent to render MCP Apps.
 */
export class RecordingTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private pending = new Map<string | number, { tool: string; args: Record<string, unknown>; t0: number }>();
  readonly calls: ToolCallRecord[] = [];
  /** tools/call requests sent since the last drain (some may still be running). */
  sent = 0;
  /** While a turn that was given up on is still winding down, its tool calls are refused. */
  blocked = false;

  constructor(private readonly inner: StreamableHTTPClientTransport) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = (e) => this.onerror?.(e);
    inner.onmessage = (m) => {
      const msg = m as { id?: string | number; result?: { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { type: string; text?: string }[] } };
      if (msg.id !== undefined && this.pending.has(msg.id) && msg.result) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        const sc = msg.result.structuredContent ?? {};
        this.calls.push({
          tool: p.tool,
          args: p.args,
          result: { isError: !!msg.result.isError, spoken: String(sc.spoken ?? msg.result.content?.[0]?.text ?? ''), structuredContent: sc },
          ms: Math.round(performance.now() - p.t0),
        });
      }
      this.onmessage?.(m);
    };
  }

  get sessionId() {
    return this.inner.sessionId;
  }

  get protocolVersion() {
    return this.inner.protocolVersion;
  }

  setProtocolVersion(v: string) {
    this.inner.setProtocolVersion(v);
  }

  start() {
    return this.inner.start();
  }

  close() {
    return this.inner.close();
  }

  send(message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) {
    const m = message as { id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (m.method === 'tools/call' && m.id !== undefined) {
      if (this.blocked) return Promise.reject(new Error('This turn was handed to the planner.'));
      this.sent++;
      this.pending.set(m.id, { tool: String(m.params?.name), args: m.params?.arguments ?? {}, t0: performance.now() });
    }
    return this.inner.send(message, options);
  }

  /** Calls made since the last drain. */
  drain(): ToolCallRecord[] {
    this.sent = 0;
    return this.calls.splice(0, this.calls.length);
  }
}

export interface StrandsOptions {
  mcpUrl: string;
  model: Model;
  /** Shown on the simulator and in replies, e.g. "claude-opus-5-5". */
  modelLabel?: string;
  /** The household's wall-clock time (UTC fields hold local time); read on every turn so the date never goes stale. */
  now: () => Date;
  uiFor: (tool: string) => string | undefined;
  /** Called after every model request with its token usage (cost logs). */
  onModelCall?: (call: ModelCall) => void;
  /** If the model has not called a tool by then, give up so the planner can answer. Default 20 s. */
  firstToolTimeoutMs?: number;
  /** Hard cap for a turn once tools have run; the reply is then built from the tool results. Default 60 s. */
  turnTimeoutMs?: number;
}

/** A conversation longer than this starts over (state lives in the MCP server, not in the chat). */
const MAX_MESSAGES = 80;

/** One Strands agent per conversation, all sharing one MCP connection (the simulator holds one conversation). */
export class StrandsAgentRunner {
  private transport: RecordingTransport;
  private mcp: McpClient;
  private agents = new Map<string, Agent>();
  private turnCalls: ModelCall[] = [];

  constructor(private readonly opts: StrandsOptions) {
    this.transport = new RecordingTransport(new StreamableHTTPClientTransport(new URL(opts.mcpUrl)));
    this.mcp = new McpClient({ transport: this.transport, applicationName: 'home-ahead-strands', disableMcpInstrumentation: true });
    meter(opts.model, (c) => {
      this.turnCalls.push(c);
      opts.onModelCall?.(c);
    });
  }

  get protocolVersion(): string | undefined {
    return this.transport.protocolVersion;
  }

  private agent(id: string): Agent {
    let a = this.agents.get(id);
    if (!a || a.messages.length > MAX_MESSAGES) {
      a = new Agent({
        model: this.opts.model,
        tools: [this.mcp],
        // The system prompt never changes, and no earlier turn is trimmed or edited: Claude's thinking
        // blocks are only valid while everything before them is unchanged.
        systemPrompt: SYSTEM_PROMPT,
        conversationManager: new NullConversationManager(),
        printer: false,
      });
      this.agents.set(id, a);
    }
    return a;
  }

  reset(id = 'default') {
    this.agents.delete(id);
  }

  /** `announced`: alerts the display spoke since the last turn, so "What should I do?" has a referent. */
  async handle(text: string, conversationId = 'default', announced: string[] = []): Promise<AgentReply> {
    this.transport.drain();
    this.turnCalls = [];
    const agent = this.agent(conversationId);
    const cancel = new AbortController();
    const firstTool = setTimeout(() => {
      if (!this.transport.sent) cancel.abort(new ModelTimeoutError('The model did not reach a tool in time.'));
    }, this.opts.firstToolTimeoutMs ?? 20_000);
    const wholeTurn = setTimeout(() => cancel.abort(new ModelTimeoutError('The turn took too long.')), this.opts.turnTimeoutMs ?? 60_000);
    // Strands stops at its next checkpoint, after any model request in flight; do not wait for that.
    const gaveUp = new Promise<never>((_, reject) => cancel.signal.addEventListener('abort', () => reject(cancel.signal.reason)));
    const run = agent.invoke(userTurn(text, this.opts.now(), announced), { cancelSignal: cancel.signal });
    let answer = '';
    try {
      const result = await Promise.race([run, gaveUp]);
      if (result.stopReason === 'refusal') throw new Error('The model declined this request.');
      answer = result.toString().trim();
    } catch (err) {
      if (cancel.signal.aborted) {
        // The abandoned run may still be finishing a model request; keep it from touching the home.
        this.transport.blocked = true;
        void run.catch(() => {}).finally(() => (this.transport.blocked = false));
      }
      const calls = this.transport.drain();
      // The conversation history may be half written, so start it fresh next turn.
      this.agents.delete(conversationId);
      // Nothing ran yet: let the caller fall back to the planner.
      if (!calls.length) throw err;
      // Tools already ran (an item added, an order placed). Answering again with the planner would
      // repeat those side effects, so report what was done.
      console.warn('[agent] Strands stopped after tool calls; answering from the tool results:', (err as Error).message);
      return this.reply(calls, '');
    } finally {
      clearTimeout(firstTool);
      clearTimeout(wholeTurn);
    }
    return this.reply(this.transport.drain(), answer);
  }

  private reply(calls: ToolCallRecord[], answer: string): AgentReply {
    const spoken = answer || calls[calls.length - 1]?.result.spoken || "Sorry, I didn't get that.";
    const withUi = calls.filter((c) => this.opts.uiFor(c.tool));
    const decisive = withUi.filter((c) => !c.result.isError && c.result.structuredContent.verdict !== 'need_info');
    const chosen = decisive[decisive.length - 1] ?? withUi[withUi.length - 1];
    const ui: UiRef | null = chosen
      ? { tool: chosen.tool, resourceUri: this.opts.uiFor(chosen.tool)!, args: chosen.args, result: chosen.result.structuredContent, isError: chosen.result.isError }
      : null;
    const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheWriteInputTokens' | 'ms') => this.turnCalls.reduce((n, c) => n + c[k], 0);
    const usage: TurnUsage = {
      modelCalls: this.turnCalls.length,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadInputTokens: sum('cacheReadInputTokens'),
      cacheWriteInputTokens: sum('cacheWriteInputTokens'),
      modelMs: sum('ms'),
    };
    return { spoken, calls, ui, mode: 'strands', model: this.opts.modelLabel, usage, protocolVersion: this.protocolVersion };
  }

  async close() {
    await this.mcp.disconnect?.();
  }
}

/** Claude through the Anthropic API, set up the way Claude Opus 5.5 expects. */
export async function anthropicModel(opts: { apiKey: string; modelId?: string; effort?: string; clientConfig?: Record<string, unknown> }): Promise<Model> {
  const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic');
  return new AnthropicModel({
    apiKey: opts.apiKey,
    modelId: opts.modelId ?? 'claude-opus-5-5',
    // Thinking is always on for Claude Opus 5.5 and counts toward max_tokens.
    maxTokens: 8000,
    params: {
      thinking: { type: 'adaptive' },
      // A voice turn should come back fast; effort is the latency control on this model.
      output_config: { effort: opts.effort ?? 'low' },
      // If a safety classifier declines a request, the API retries it on the model Anthropic recommends.
      fallbacks: 'default',
    },
    betas: ['server-side-fallback-2026-07-01'],
    // Caches the tool definitions, the system prompt and the conversation so far.
    cacheConfig: { strategy: 'anthropic' },
    clientConfig: { maxRetries: 1, timeout: 30_000, ...opts.clientConfig },
  });
}

/** Pick a model from the environment: Anthropic API key first, then Amazon Bedrock. */
export async function modelFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ model: Model; label: string } | null> {
  if (env.HOME_AHEAD_AGENT === 'planner') return null;
  if (env.ANTHROPIC_API_KEY) {
    const modelId = env.HOME_AHEAD_MODEL_ID ?? 'claude-opus-5-5';
    return { model: await anthropicModel({ apiKey: env.ANTHROPIC_API_KEY, modelId, effort: env.HOME_AHEAD_EFFORT }), label: modelId };
  }
  if (env.HOME_AHEAD_AGENT === 'bedrock' || (env.AWS_REGION && (env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID))) {
    const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock');
    // Bedrock model IDs and inference profiles differ by account and region, so there is no safe default.
    const modelId = env.HOME_AHEAD_MODEL_ID;
    if (!modelId) {
      throw new Error('Bedrock needs HOME_AHEAD_MODEL_ID (a model ID or inference profile your AWS account can invoke in AWS_REGION).');
    }
    return { model: new BedrockModel({ modelId, region: env.AWS_REGION ?? 'us-west-2', maxTokens: 2048 }), label: `Amazon Bedrock ${modelId}` };
  }
  return null;
}
