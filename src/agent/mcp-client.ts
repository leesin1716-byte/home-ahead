// 에이전트가 자기 MCP 서버를 HTTP로 부르는 클라이언트(SDK v2). 도구 호출마다 이름·인자·결과·지연을 기록한다
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result: { isError: boolean; spoken: string; structuredContent: Record<string, unknown> };
  ms: number;
}

export interface ToolInfo {
  name: string;
  uiResourceUri?: string;
}

export class HomeAheadClient {
  private client = new Client({ name: 'home-ahead-agent', version: '0.1.0' });
  private tools = new Map<string, ToolInfo>();

  constructor(private readonly mcpUrl: string) {}

  async connect(): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.mcpUrl)));
    const { tools } = await this.client.listTools();
    for (const t of tools) {
      const meta = (t._meta ?? {}) as { ui?: { resourceUri?: string } };
      this.tools.set(t.name, { name: t.name, uiResourceUri: meta.ui?.resourceUri });
    }
  }

  get protocolVersion(): string | undefined {
    return this.client.getNegotiatedProtocolVersion();
  }

  tool(name: string): ToolInfo | undefined {
    return this.tools.get(name);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const t0 = performance.now();
    const res = await this.client.callTool({ name: tool, arguments: args });
    const structured = (res.structuredContent ?? {}) as Record<string, unknown>;
    const text = (res.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === 'text')?.text ?? '';
    return {
      tool,
      args,
      result: { isError: !!res.isError, spoken: String(structured.spoken ?? text), structuredContent: structured },
      ms: Math.round(performance.now() - t0),
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
