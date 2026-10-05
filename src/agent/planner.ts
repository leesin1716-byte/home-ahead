// 결정적 플래너: 모델 키가 없을 때 사용자 말을 규칙으로 해석해 같은 MCP 도구를 HTTP로 부른다(대화 상태·되묻기 포함)
import { detectCategories, CATEGORIES, type CategoryId } from '../domain/categories.js';
import { stageFromMilestone } from '../domain/stages.js';
import type { HomeAheadClient, ToolCallRecord } from './mcp-client.js';

export interface UiRef {
  tool: string;
  resourceUri: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  isError: boolean;
}

export interface AgentReply {
  spoken: string;
  calls: ToolCallRecord[];
  ui: UiRef | null;
  mode: 'planner' | 'strands';
  protocolVersion?: string;
}

interface SecondhandInput {
  category: CategoryId;
  name?: string;
  model?: string;
  hasBumpers?: boolean;
  room?: string;
  source: 'hand_me_down' | 'secondhand';
}

interface Conversation {
  pending?: { input: SecondhandInput; asked: string[] };
  queue: SecondhandInput[];
  orderToken?: string;
  offeredSupplies?: boolean;
}

const DEFAULT_ROOM: Partial<Record<CategoryId, string>> = {
  crib: 'nursery',
  bassinet: 'nursery',
  dresser: 'nursery',
  high_chair: 'kitchen',
  tv: 'living room',
};

const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|please( do)?|go ahead|do it|sounds good|place (it|the order)|order (it|them)|that'?s right|correct)\b/i;
const NO = /^(no|nope|not now|don'?t|cancel|never ?mind)\b/i;
const MODEL = /\b(?=[A-Z0-9./-]*\d)(?=[A-Z0-9./-]*[A-Z])[A-Z0-9]{1,8}(?:[-./][A-Z0-9]{1,10})*\b/gi;
const ROOM = /\b(?:in|for) (?:the |our |my )?(nursery|living room|kitchen|bedroom|playroom|bathroom|family room|dining room|hallway|basement)\b/i;

/** Find a model number in what the user said ("It says TB-HC6900"). */
export function extractModel(text: string): string | undefined {
  const words = text.match(MODEL) ?? [];
  // Skip ordinal/measure words like "8-drawer" or "10am".
  return words.find((w) => !/^\d+(am|pm|th|st|nd|rd|-drawer|in|ft)$/i.test(w) && w.length >= 3);
}

/** "Saturday morning" -> "2026-09-19T10:00", relative to the (possibly simulated) clock. */
export function parseWhen(text: string, now: Date): string | undefined {
  const t = text.toLowerCase();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let date: Date | undefined;
  const dayIdx = days.findIndex((d) => t.includes(d));
  if (dayIdx >= 0) {
    const diff = (dayIdx - now.getUTCDay() + 7) % 7 || 7;
    date = new Date(now.getTime() + diff * 864e5);
  } else if (/\btomorrow\b/.test(t)) date = new Date(now.getTime() + 864e5);
  else if (/\btoday|tonight\b/.test(t)) date = now;
  else if (/\bthis weekend|weekend\b/.test(t)) date = new Date(now.getTime() + (((6 - now.getUTCDay() + 7) % 7) || 7) * 864e5);
  if (!date) return undefined;
  let hh = 10;
  let mm = 0;
  const at = t.match(/\bat (\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
  if (at) {
    hh = Number(at[1]) % 12;
    mm = Number(at[2] ?? 0);
    if (at[3]?.startsWith('p') || (!at[3] && hh < 7)) hh += 12;
    if (at[3]?.startsWith('a') && hh === 12) hh = 0;
  } else if (/afternoon/.test(t)) hh = 14;
  else if (/evening|tonight/.test(t)) hh = 18;
  else if (/morning/.test(t)) hh = 10;
  return `${date.toISOString().slice(0, 10)}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export class Planner {
  private conversations = new Map<string, Conversation>();

  constructor(
    private readonly client: HomeAheadClient,
    private readonly now: () => Date,
  ) {}

  reset(conversationId = 'default') {
    this.conversations.delete(conversationId);
  }

  private conv(id: string): Conversation {
    let c = this.conversations.get(id);
    if (!c) this.conversations.set(id, (c = { queue: [] }));
    return c;
  }

  async handle(text: string, conversationId = 'default'): Promise<AgentReply> {
    const calls: ToolCallRecord[] = [];
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r = await this.client.call(tool, args);
      calls.push(r);
      return r;
    };
    const spoken = await this.route(text.trim(), this.conv(conversationId), call);
    return { spoken, calls, ui: this.pickUi(calls), mode: 'planner', protocolVersion: this.client.protocolVersion };
  }

  /** Show the most useful screen: the last decisive result that has an MCP App. */
  private pickUi(calls: ToolCallRecord[]): UiRef | null {
    const withUi = calls.filter((c) => this.client.tool(c.tool)?.uiResourceUri);
    const decisive = withUi.filter((c) => !c.result.isError && c.result.structuredContent.verdict !== 'need_info');
    const chosen = decisive[0] ?? withUi[withUi.length - 1];
    if (!chosen) return null;
    return {
      tool: chosen.tool,
      resourceUri: this.client.tool(chosen.tool)!.uiResourceUri!,
      args: chosen.args,
      result: chosen.result.structuredContent,
      isError: chosen.result.isError,
    };
  }

  private async route(text: string, c: Conversation, call: (tool: string, args: Record<string, unknown>) => Promise<ToolCallRecord>): Promise<string> {
    const lower = text.toLowerCase().replace(/^(alexa|hey alexa)[,\s]+/, '');

    // 1. A cart is waiting for a yes or no.
    if (c.orderToken) {
      if (YES.test(lower)) {
        const token = c.orderToken;
        c.orderToken = undefined;
        return (await call('confirm_supply_order', { token })).result.spoken;
      }
      if (NO.test(lower)) {
        c.orderToken = undefined;
        return "Okay, I won't order anything.";
      }
    }

    // 2. Answering a question about a hand-me-down.
    if (c.pending) {
      const answered = this.fillAnswer(c.pending.input, lower, text);
      if (answered) {
        c.pending = undefined;
        return this.checkSecondhand(answered, c, call, '');
      }
    }

    // 3. Offered supplies after a re-check.
    if (c.offeredSupplies && YES.test(lower)) {
      c.offeredSupplies = false;
      return this.prepareOrder(c, call);
    }
    c.offeredSupplies = false;

    const categories = detectCategories(lower).filter((x) => x !== 'other');

    // 4. Hand-me-downs and used items.
    if (categories.length && /(giving us|gave us|give us|hand[- ]?me[- ]?down|handed down|used|second[- ]?hand|from (my|our) (sister|brother|friend|neighbou?r|mom|dad|parents|cousin)|garage sale|yard sale|thrift|marketplace|passing (it|them) down)/.test(lower)) {
      const room = lower.match(ROOM)?.[1];
      const items = categories.slice(0, 3).map<SecondhandInput>((category) => ({
        category,
        room: room ?? DEFAULT_ROOM[category],
        source: /bought|thrift|garage|yard|marketplace|used/.test(lower) ? 'secondhand' : 'hand_me_down',
      }));
      const model = items.length === 1 ? extractModel(text) : undefined;
      if (model) items[0].model = model;
      c.queue = items.slice(1);
      return this.checkSecondhand(items[0], c, call, items.length > 1 ? `Happy to check ${items.length === 2 ? 'both' : 'all of them'}. ` : '');
    }

    // 5. A milestone ("she pulled herself up on the couch").
    const milestone = stageFromMilestone(lower);
    if (milestone && /\b(she|he|they|baby|started|just|today|first)\b/.test(lower) && !/\?$/.test(lower) && !/next stage/.test(lower)) {
      const r = await call('set_child_stage', { milestone: text });
      c.offeredSupplies = /supplies\?$/.test(r.result.spoken);
      return r.result.spoken;
    }

    // 6. Preview of the next stage.
    if (/next stage|ready for (the )?next|what('s| is) (coming )?next/.test(lower)) {
      return (await call('get_safety_plan', { stage: 'next' })).result.spoken;
    }

    // 7. Progress on a recall remedy.
    if (/\b(asked|requested|emailed|called|contacted|filed|signed up|ordered)\b.*\b(kit|refund|repair|replacement|recall|them|company|fix)\b/.test(lower) && !/\bsupplies\b/.test(lower)) {
      return (await call('update_task', { recall: 'latest', remedyStatus: 'requested', task: text })).result.spoken;
    }
    if (/\b(got|received|came|arrived|installed)\b.*\b(refund|kit|replacement|fix)\b/.test(lower)) {
      return (await call('update_task', { recall: 'latest', remedyStatus: 'resolved', task: text })).result.spoken;
    }

    // 8. Scheduling.
    if (/\b(remind|schedule|calendar|put .* on)\b/.test(lower)) {
      const when = parseWhen(lower, this.now());
      if (!when) return 'When should I put it on the calendar?';
      return (await call('update_task', { task: text, action: 'schedule', when })).result.spoken;
    }

    // 9. Reporting something done.
    if (/\b(we|i)('ve| have)?\b.*\b(anchored|strapped|installed|did|finished|fixed|removed|took out|tied up|put up|mounted|secured)\b/.test(lower)) {
      return (await call('update_task', { task: text, action: 'complete' })).result.spoken;
    }

    // 10. Supplies.
    if (/\b(order|buy|cart|shopping|get (the |me |us )?(supplies|kits?|them|those|what we need))\b/.test(lower)) {
      return this.prepareOrder(c, call);
    }

    // 11. What to do about a recall.
    if (/what (should|do) (i|we) do|what now|how do (i|we) fix|tell me more|more details/.test(lower)) {
      return (await call('get_recall_guidance', {})).result.spoken;
    }

    // 12. Recall check.
    if (/recall/.test(lower)) return (await call('check_recalls', {})).result.spoken;

    // 13. The plan.
    if (/plan|what('s| is) left|to-?do|checklist|safety check|baby-?proof|child-?proof/.test(lower)) {
      return (await call('get_safety_plan', {})).result.spoken;
    }

    // 14. New things in the home.
    if (categories.length && /\b(we have|we've got|we got|add|bought|register|new|just (got|installed|set up))\b/.test(lower)) {
      const room = lower.match(ROOM)?.[1];
      const model = categories.length === 1 ? extractModel(text) : undefined;
      const items = categories.slice(0, 5).map((category) => ({ category, room: room ?? DEFAULT_ROOM[category], ...(model ? { model } : {}) }));
      return (await call('add_items', { items })).result.spoken;
    }

    return 'I can check hand-me-downs for recalls, re-check your home when your baby reaches a new stage, and get safety supplies. What would you like to do?';
  }

  private fillAnswer(input: SecondhandInput, lower: string, raw: string): SecondhandInput | undefined {
    const out = { ...input };
    let got = false;
    const model = extractModel(raw);
    if (model && !out.model) {
      out.model = model;
      got = true;
    }
    if (out.category === 'crib' && out.hasBumpers === undefined) {
      if (/bumper/.test(lower)) {
        out.hasBumpers = !/\b(no|not|without|doesn'?t|does not|didn'?t|none)\b[^.]*bumper|bumpers?\b[^.]*\b(no|not|none)\b/.test(lower);
        got = true;
      } else if (!model && (YES.test(lower) || NO.test(lower))) {
        out.hasBumpers = YES.test(lower);
        got = true;
      }
    }
    if (!got && /don'?t know|can'?t find|no label|not sure/.test(lower)) {
      out.model = undefined;
      return { ...out, name: out.name ?? CATEGORIES[out.category].label };
    }
    return got ? out : undefined;
  }

  private async checkSecondhand(
    input: SecondhandInput,
    c: Conversation,
    call: (tool: string, args: Record<string, unknown>) => Promise<ToolCallRecord>,
    prefix: string,
  ): Promise<string> {
    const r = await call('check_secondhand_item', { ...input });
    const sc = r.result.structuredContent as { verdict?: string; questions?: string[] };
    if (sc.verdict === 'need_info' || (sc.questions?.length && sc.verdict !== 'do_not_use' && !input.model)) {
      c.pending = { input, asked: sc.questions ?? [] };
      return `${prefix}${(sc.questions ?? []).join(' ')}`.trim();
    }
    let spoken = `${prefix}${r.result.spoken}`.trim();
    const next = c.queue.shift();
    if (next) {
      const label = CATEGORIES[next.category].label;
      const r2 = await call('check_secondhand_item', { ...next });
      const sc2 = r2.result.structuredContent as { verdict?: string; questions?: string[] };
      if (sc2.verdict === 'need_info') {
        c.pending = { input: next, asked: sc2.questions ?? [] };
        const qs = (sc2.questions ?? []).map((q) => q.replace(`the ${label}'s`, 'its'));
        spoken += ` Now the ${label}: ${qs.map((q, i) => (i === 0 ? q.charAt(0).toLowerCase() + q.slice(1) : q)).join(' ')}`;
      } else {
        spoken += ` ${r2.result.spoken}`;
      }
    }
    return spoken;
  }

  private async prepareOrder(c: Conversation, call: (tool: string, args: Record<string, unknown>) => Promise<ToolCallRecord>): Promise<string> {
    const r = await call('prepare_supply_order', {});
    const order = (r.result.structuredContent as { order?: { token?: string } | null }).order;
    if (order?.token) c.orderToken = order.token;
    return r.result.spoken;
  }
}
