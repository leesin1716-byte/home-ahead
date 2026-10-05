// Strands Agents 경로: 모델 키가 있으면 Strands 에이전트가 MCP 클라이언트(SDK v1)로 같은 서버의 도구를 고른다
import { Agent, McpClient, type Model } from '@strands-agents/sdk';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { ToolCallRecord } from './mcp-client.js';
import type { AgentReply, UiRef } from './planner.js';

export const SYSTEM_PROMPT = `You are Home Ahead, an add-on for a voice assistant on a kitchen smart display.
You help a family keep their home safe as their baby grows, using the Home Ahead tools.
- Use a tool for anything about the child's stage, items in the home, hand-me-downs, recalls, the safety plan, supplies or tasks.
- Each tool result has a "spoken" field. Reply with that text, lightly joined if you called more than one tool. Keep replies under 30 seconds of speech.
- Never read out URLs, IDs, JSON or tool names.
- Never call confirm_supply_order unless the user has just clearly said yes to the cart you prepared.
- When a tool asks a question (for example a model number), ask it and wait for the answer.
- Today's date is {today}.`;

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
      this.pending.set(m.id, { tool: String(m.params?.name), args: m.params?.arguments ?? {}, t0: performance.now() });
    }
    return this.inner.send(message, options);
  }

  /** Calls made since the last drain. */
  drain(): ToolCallRecord[] {
    return this.calls.splice(0, this.calls.length);
  }
}

export interface StrandsOptions {
  mcpUrl: string;
  model: Model | string;
  now: () => Date;
  uiFor: (tool: string) => string | undefined;
}

/** One Strands agent per conversation, all sharing one MCP connection. */
export class StrandsAgentRunner {
  private transport: RecordingTransport;
  private mcp: McpClient;
  private agents = new Map<string, Agent>();

  constructor(private readonly opts: StrandsOptions) {
    this.transport = new RecordingTransport(new StreamableHTTPClientTransport(new URL(opts.mcpUrl)));
    this.mcp = new McpClient({ transport: this.transport, applicationName: 'home-ahead-strands', disableMcpInstrumentation: true });
  }

  get protocolVersion(): string | undefined {
    return this.transport.protocolVersion;
  }

  private agent(id: string): Agent {
    let a = this.agents.get(id);
    if (!a) {
      a = new Agent({
        model: this.opts.model,
        tools: [this.mcp],
        systemPrompt: SYSTEM_PROMPT.replace('{today}', this.opts.now().toDateString()),
        printer: false,
      });
      this.agents.set(id, a);
    }
    return a;
  }

  reset(id = 'default') {
    this.agents.delete(id);
  }

  async handle(text: string, conversationId = 'default'): Promise<AgentReply> {
    this.transport.drain();
    const result = await this.agent(conversationId).invoke(text);
    const calls = this.transport.drain();
    const spoken = result.toString().trim() || calls[calls.length - 1]?.result.spoken || "Sorry, I didn't get that.";
    const withUi = calls.filter((c) => this.opts.uiFor(c.tool));
    const decisive = withUi.filter((c) => !c.result.isError && c.result.structuredContent.verdict !== 'need_info');
    const chosen = decisive[decisive.length - 1] ?? withUi[withUi.length - 1];
    const ui: UiRef | null = chosen
      ? { tool: chosen.tool, resourceUri: this.opts.uiFor(chosen.tool)!, args: chosen.args, result: chosen.result.structuredContent, isError: chosen.result.isError }
      : null;
    return { spoken, calls, ui, mode: 'strands', protocolVersion: this.protocolVersion };
  }

  async close() {
    await this.mcp.disconnect?.();
  }
}

/** Pick a model from the environment: Anthropic API key first, then Amazon Bedrock. */
export async function modelFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ model: Model; label: string } | null> {
  if (env.HOME_AHEAD_AGENT === 'planner') return null;
  if (env.ANTHROPIC_API_KEY) {
    const { AnthropicModel } = await import('@strands-agents/sdk/models/anthropic');
    const modelId = env.HOME_AHEAD_MODEL_ID ?? 'claude-opus-5-5';
    return { model: new AnthropicModel({ modelId, maxTokens: 2048 }), label: `Anthropic ${modelId}` };
  }
  if (env.HOME_AHEAD_AGENT === 'bedrock' || (env.AWS_REGION && (env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID))) {
    const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock');
    const modelId = env.HOME_AHEAD_MODEL_ID ?? 'global.anthropic.claude-opus-5-5';
    return { model: new BedrockModel({ modelId, region: env.AWS_REGION ?? 'us-west-2', maxTokens: 2048 }), label: `Amazon Bedrock ${modelId}` };
  }
  return null;
}
