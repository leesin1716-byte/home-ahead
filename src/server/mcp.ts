// MCP 서버 정의: 고객 의도 하나당 도구 하나(9개), 리소스 2개(구독 가능한 알림 포함), MCP Apps UI 3종
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { CATEGORY_IDS } from '../domain/categories.js';
import type { Outcome } from '../domain/service.js';
import { STAGES } from '../domain/types.js';
import type { AppContext } from '../context.js';
import type { UiView } from './ui-bundle.js';

export const SERVER_INFO = { name: 'home-ahead', title: 'Home Ahead', version: '0.1.0' };
export const ALERTS_URI = 'home://alerts';
export const HOUSEHOLD_URI = 'home://household';

const INSTRUCTIONS = `Home Ahead keeps a family's home one step ahead of their child's development.
It remembers the child's stage and the things in the home, checks belongings against U.S. CPSC recall notices,
and turns that into a short plan. Every tool returns a "spoken" field that is ready to read aloud;
read it as-is. Never place an order without calling prepare_supply_order first and getting a clear yes.`;

const Stage = z.enum(STAGES);
const Category = z.enum(CATEGORY_IDS);

const ItemInput = z.object({
  category: Category.describe('Kind of product'),
  name: z.string().max(60).optional().describe('What the family calls it, e.g. "nursery dresser"'),
  brand: z.string().max(60).optional(),
  model: z.string().max(40).optional().describe('Model or SKU from the label'),
  room: z.string().max(40).optional(),
  source: z.enum(['owned', 'hand_me_down', 'secondhand']).optional(),
  anchored: z.boolean().optional().describe('Furniture/TV is strapped to the wall'),
  corded: z.boolean().optional().describe('Window covering has pull cords'),
  hasBumpers: z.boolean().optional().describe('Crib comes with padded bumpers'),
});

/** Every result carries the line to speak; the rest is structured data for screens. */
const Out = <T extends z.ZodRawShape>(shape: T) => z.looseObject({ spoken: z.string(), ...shape });

function toResult(o: Outcome<object>): CallToolResult {
  const structuredContent = { spoken: o.spoken, ...o.data };
  return {
    // The line to speak first, then the serialized structured data, as the MCP spec recommends for
    // clients that read only `content` (Strands does; without it a model never sees the cart token).
    content: [
      { type: 'text', text: o.spoken },
      { type: 'text', text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
    ...(o.isError ? { isError: true } : {}),
  };
}

/** Run a tool body; anything unexpected becomes one speakable sentence instead of a stack trace. */
function safe(fn: () => Outcome<object>): CallToolResult {
  try {
    return toResult(fn());
  } catch (err) {
    console.error('[tool error]', err);
    return toResult({ isError: true, spoken: 'Sorry, something went wrong on my side. Please try that again.', data: { error: 'internal' } });
  }
}

export interface SessionHooks {
  onSubscribe(uri: string): void;
  onUnsubscribe(uri: string): void;
}

export function buildMcpServer(ctx: AppContext, ui: Record<UiView['key'], UiView>, hooks: SessionHooks): McpServer {
  const s = ctx.service;
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: { resources: { subscribe: true, listChanged: false } },
  });

  const uiMeta = (key: UiView['key']) => ({ ui: { resourceUri: ui[key].uri } });
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  registerAppTool(
    server,
    'set_child_stage',
    {
      title: 'Update child stage',
      description:
        "Record a child's nickname, birth month, or a milestone the parent noticed (\"she pulled herself up\"). When the stage changes, re-checks the home and returns the new room-by-room findings.",
      inputSchema: z.object({
        nickname: z.string().max(30).optional().describe('First name or nickname only'),
        birthMonth: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('YYYY-MM; never a full birth date'),
        observedStage: Stage.optional(),
        milestone: z.string().max(200).optional().describe("The parent's own words about what the child just did"),
      }),
      outputSchema: Out({ changed: z.boolean().optional(), child: z.object({ nickname: z.string(), stage: Stage }).loose().optional() }),
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
      _meta: uiMeta('safety-plan'),
    },
    async (args) => safe(() => s.setChildStage(args)),
  );

  registerAppTool(
    server,
    'add_items',
    {
      title: 'Add things in the home',
      description: 'Register one or more items in the home (with room and where it came from). Each is checked against recall notices right away.',
      inputSchema: z.object({ items: z.array(ItemInput).min(1).max(20) }),
      outputSchema: Out({ added: z.array(z.object({ name: z.string() }).loose()).optional() }),
      annotations: { destructiveHint: false, openWorldHint: false },
      _meta: uiMeta('recall-card'),
    },
    async (args) => safe(() => s.addItems(args)),
  );

  registerAppTool(
    server,
    'check_secondhand_item',
    {
      title: 'Check a hand-me-down',
      description:
        'Decide whether a used or hand-me-down baby item is OK to bring home: use, fix first, or do not use. Checks recalls and federal bans. If it needs the model number or another detail it returns questions to ask.',
      inputSchema: ItemInput.extend({ register: z.boolean().optional().describe('Add it to the home after checking (default true)') }),
      outputSchema: Out({ verdict: z.enum(['use', 'fix_first', 'do_not_use', 'need_info']).optional(), questions: z.array(z.string()).optional() }),
      annotations: { destructiveHint: false, openWorldHint: false },
      _meta: uiMeta('recall-card'),
    },
    async (args) => safe(() => s.checkSecondhandItem(args)),
  );

  registerAppTool(
    server,
    'check_recalls',
    {
      title: 'Check the home for recalls',
      description: 'Re-check everything in the home against recall notices. New matches come first; at most five are returned.',
      inputSchema: z.object({ onlyNew: z.boolean().optional() }),
      outputSchema: Out({ matches: z.array(z.object({ recallNumber: z.string() }).loose()).max(5).optional() }),
      annotations: readOnly,
      _meta: uiMeta('recall-card'),
    },
    async (args) => safe(() => s.checkRecalls(args)),
  );

  registerAppTool(
    server,
    'get_recall_guidance',
    {
      title: 'What to do about a recall',
      description: 'Explain what to do about a recall that affects this home: whether to stop using it, the remedy, and how to contact the company. Defaults to the most recent open recall.',
      inputSchema: z.object({ recallNumber: z.string().optional(), item: z.string().optional().describe('Item name, e.g. "dresser"') }),
      outputSchema: Out({ recall: z.object({ recallNumber: z.string() }).loose().optional() }),
      annotations: readOnly,
      _meta: uiMeta('recall-card'),
    },
    async (args) => safe(() => s.getRecallGuidance(args)),
  );

  registerAppTool(
    server,
    'get_safety_plan',
    {
      title: 'Room-by-room safety plan',
      description: "The room-by-room plan for the child's current stage, or a preview of the next stage with stage: \"next\".",
      inputSchema: z.object({ stage: z.union([Stage, z.literal('next')]).optional(), nickname: z.string().optional() }),
      outputSchema: Out({ stage: Stage.optional(), openCount: z.number().optional() }),
      annotations: { destructiveHint: false, openWorldHint: false },
      _meta: uiMeta('safety-plan'),
    },
    async (args) => safe(() => s.getSafetyPlan(args)),
  );

  registerAppTool(
    server,
    'prepare_supply_order',
    {
      title: 'Prepare a safety supplies cart',
      description:
        'Put the supplies the plan calls for (or specific SKUs) in a cart from the demo store and return a confirmation token. Nothing is ordered until confirm_supply_order is called with that token after the user says yes.',
      inputSchema: z.object({ skus: z.array(z.string()).max(10).optional() }),
      outputSchema: Out({ order: z.object({ token: z.string(), total: z.number() }).loose().nullable().optional() }),
      annotations: { destructiveHint: false, openWorldHint: false },
      _meta: uiMeta('cart'),
    },
    async (args) => safe(() => s.prepareSupplyOrder(args)),
  );

  registerAppTool(
    server,
    'confirm_supply_order',
    {
      title: 'Place the order',
      description: 'Place the order for a prepared cart. Only call this after the user clearly confirms. Calling it again with the same token never orders twice.',
      inputSchema: z.object({ token: z.string().min(1) }),
      outputSchema: Out({ order: z.object({ status: z.string() }).loose().optional(), alreadyConfirmed: z.boolean().optional() }),
      annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
      _meta: uiMeta('cart'),
    },
    async (args) => safe(() => s.confirmSupplyOrder(args)),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update the to-do list',
      description:
        'Mark a home-safety task done, schedule it (when: local "YYYY-MM-DDTHH:mm"), snooze it a week, or record progress on a recall remedy (recall: number or "latest", remedyStatus: requested/resolved).',
      inputSchema: z.object({
        task: z.string().max(200).optional().describe("The user's words for the task, e.g. \"anchored the dresser\""),
        action: z.enum(['complete', 'schedule', 'snooze', 'reopen']).optional(),
        when: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
        recall: z.string().optional(),
        remedyStatus: z.enum(['requested', 'resolved']).optional(),
      }),
      outputSchema: Out({ tasks: z.array(z.object({ title: z.string() }).loose()).optional() }),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (args) => safe(() => s.updateTask(args)),
  );

  // ---- resources
  server.registerResource(
    'household',
    HOUSEHOLD_URI,
    { title: 'Household summary', description: 'Children (nickname and stage), items, open tasks, open recalls.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(s.householdSummary()) }] }),
  );
  server.registerResource(
    'alerts',
    ALERTS_URI,
    { title: 'Proactive alerts', description: 'New recalls that reach this home and stage changes. Subscribe to be notified.', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(s.alerts()) }] }),
  );
  for (const view of Object.values(ui)) {
    registerAppResource(server, view.title, view.uri, { description: `MCP App: ${view.title}` }, async () => ({
      contents: [
        {
          uri: view.uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: view.html,
          _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
        },
      ],
    }));
  }

  server.server.setRequestHandler('resources/subscribe', async (req) => {
    hooks.onSubscribe(req.params.uri);
    return {};
  });
  server.server.setRequestHandler('resources/unsubscribe', async (req) => {
    hooks.onUnsubscribe(req.params.uri);
    return {};
  });
  return server;
}
