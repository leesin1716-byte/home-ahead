// Home Ahead 핵심 서비스: MCP 도구 9개가 부르는 업무 로직(단계·물건·리콜·계획·주문·할 일)을 한곳에 모은다
import { randomBytes } from 'node:crypto';
import type { RecallIndex } from '../cpsc/index.js';
import type { RecallRecord } from '../cpsc/normalize.js';
import { CATEGORIES, type CategoryId } from './categories.js';
import type { Clock } from './clock.js';
import { categoryHasRecalls, findRecallHits, type RecallHit } from './matching.js';
import { recallView, type RecallView } from './recall-view.js';
import { findingsFor, type Finding, type RuleFile } from './rules.js';
import { capitalize, countPhrase, listPhrase, money } from './speech.js';
import { ageInMonths, effectiveStage, nextStage, STAGE_LABELS, stageFromMilestone } from './stages.js';
import type { Alert, Child, Household, Item, ItemSource, Order, RecallMatch, RemedyStatus, Stage, Task } from './types.js';
import type { HouseholdStore } from '../store/store.js';

export interface Catalog {
  currency: string;
  products: { sku: string; name: string; price: number; perItem: boolean }[];
}

export interface ServiceDeps {
  store: HouseholdStore;
  index: RecallIndex;
  rules: RuleFile;
  catalog: Catalog;
  clock: Clock;
  /** Keep third-party brand names off the screen (used when recording the demo video). */
  videoSafe?: boolean;
  /** Called whenever alerts change, so the MCP layer can notify subscribers. */
  onAlertsChanged?: () => void;
}

export interface Outcome<T> {
  spoken: string;
  data: T;
  isError?: boolean;
}

export interface ItemInput {
  category: CategoryId;
  name?: string;
  brand?: string;
  model?: string;
  room?: string;
  source?: ItemSource;
  anchored?: boolean;
  corded?: boolean;
  hasBumpers?: boolean;
}

const ORDER_TTL_MS = 15 * 60 * 1000;

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

function remedyPhrase(rec: RecallRecord): string {
  const t = rec.remedies.join(' ');
  if (/free (retrofit|repair) kit|repair kit|retrofit kit/i.test(t)) return 'a free repair kit';
  if (/full refund|refund/i.test(t)) return 'a full refund';
  if (/replacement/i.test(t)) return 'a free replacement';
  if (/repair/i.test(t)) return 'a free repair';
  return 'the fix in the official notice';
}

/** Words worth matching in a task description ("anchored the dresser" -> ["anchor", "dresser"]). */
function keywords(text: string): string[] {
  const stop = new Set(['the', 'a', 'an', 'and', 'to', 'it', 'we', 'i', 'my', 'our', 'of', 'in', 'on', 'for', 'is', 'up', 'out', 'with', 'all', 'both', 'them']);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stop.has(w))
    .map((w) => w.replace(/(ed|ing|s)$/, ''));
}

/** "2026-09-19T10:00" -> "Saturday, September 19 at 10 AM" (floating local time). */
export function formatWhen(local: string): string {
  const [date, time = '09:00'] = local.split('T');
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const [hh, mm] = time.split(':').map(Number);
  const h12 = ((hh + 11) % 12) + 1;
  return `${day} at ${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''} ${hh < 12 ? 'AM' : 'PM'}`;
}

export class HomeService {
  constructor(private readonly deps: ServiceDeps) {}

  private now(): Date {
    return this.deps.clock.now();
  }

  private visible(): RecallRecord[] {
    return this.deps.index.visible(this.now());
  }

  private view(rec: RecallRecord, item?: Item, match?: RecallMatch): RecallView {
    return recallView(rec, this.deps.index, {
      videoSafe: !!this.deps.videoSafe,
      item,
      confidence: match?.confidence,
      remedyStatus: match?.remedyStatus,
    });
  }

  household(): Household {
    return this.deps.store.load();
  }

  private child(h: Household, nickname?: string): Child | undefined {
    if (nickname) return h.children.find((c) => c.nickname.toLowerCase() === nickname.toLowerCase());
    return h.children[0];
  }

  /** Record recall hits for one item; returns only the hits that were not known before. */
  private recordHits(h: Household, item: Item, hits: RecallHit[]): RecallMatch[] {
    const added: RecallMatch[] = [];
    for (const hit of hits) {
      if (h.recallMatches.some((m) => m.itemId === item.id && m.recallNumber === hit.recall.recallNumber)) continue;
      const m: RecallMatch = {
        id: newId('rm'),
        itemId: item.id,
        recallNumber: hit.recall.recallNumber,
        confidence: hit.confidence,
        firstSeenAt: this.now().toISOString(),
        remedyStatus: 'open',
      };
      h.recallMatches.push(m);
      added.push(m);
    }
    return added;
  }

  private createItem(input: ItemInput): Item {
    return {
      id: newId('it'),
      category: input.category,
      name: (input.name ?? CATEGORIES[input.category].label).toLowerCase().replace(/^(an?|the|my|our)\s+/, ''),
      brand: input.brand,
      model: input.model,
      room: input.room,
      source: input.source ?? 'owned',
      anchored: input.anchored,
      corded: input.corded,
      hasBumpers: input.hasBumpers,
      addedAt: this.now().toISOString(),
      status: 'active',
    };
  }

  private ensureTasks(h: Household, findings: Finding[]): Task[] {
    const created: Task[] = [];
    for (const f of findings) {
      if (h.tasks.some((t) => t.ruleId === f.ruleId && t.itemId === f.itemId)) continue;
      const t: Task = {
        id: newId('tk'),
        title: f.title,
        kind: 'hazard',
        ruleId: f.ruleId,
        itemId: f.itemId,
        room: f.room,
        status: 'open',
        createdAt: this.now().toISOString(),
      };
      h.tasks.push(t);
      created.push(t);
    }
    return created;
  }

  private addAlert(h: Household, a: Omit<Alert, 'id' | 'createdAt' | 'read'>): Alert {
    const alert: Alert = { ...a, id: newId('al'), createdAt: this.now().toISOString(), read: false };
    h.alerts.unshift(alert);
    h.alerts = h.alerts.slice(0, 50);
    return alert;
  }

  private markRecallAlertsRead(h: Household, recallNumber?: string): boolean {
    let changed = false;
    for (const a of h.alerts) {
      if (!a.read && a.kind === 'recall' && (!recallNumber || a.recallNumber === recallNumber)) {
        a.read = true;
        changed = true;
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------- tools

  setChildStage(input: { nickname?: string; birthMonth?: string; observedStage?: Stage; milestone?: string }) {
    const now = this.now();
    const observed = input.observedStage ?? (input.milestone ? stageFromMilestone(input.milestone) : undefined);
    if (input.milestone && !observed && !input.birthMonth) {
      return {
        isError: true,
        spoken: "I didn't catch which milestone that was. Is she rolling, sitting, crawling, pulling up, walking or climbing?",
        data: { error: 'unknown_milestone' },
      };
    }
    return this.deps.store.update((h) => {
      let child = this.child(h, input.nickname);
      if (!child) {
        if (!input.nickname) {
          return { isError: true, spoken: "What's your child's nickname? I only need a first name or a nickname.", data: { error: 'no_child' } };
        }
        child = { id: newId('ch'), nickname: input.nickname };
        h.children.push(child);
      }
      if (input.birthMonth) child.birthMonth = input.birthMonth;
      if (observed) {
        child.observedStage = observed;
        child.observedAt = now.toISOString();
      }
      const previous = child.lastAuditedStage;
      const stage = effectiveStage(child, now);
      const changed = stage !== previous;
      const findings = findingsFor(h, stage, this.deps.rules);
      const fresh = findings.filter((f) => f.newThisStage);
      if (changed) {
        this.ensureTasks(h, findings);
        child.lastAuditedStage = stage;
      }
      const open = this.openFindings(h, findings);
      const headline = (open.filter((f) => f.newThisStage).length ? open.filter((f) => f.newThisStage) : open).slice(0, 3);
      let spoken: string;
      if (!changed) {
        spoken = `${child.nickname} is already in the ${STAGE_LABELS[stage]} stage in my notes, so nothing new to check.`;
      } else if (headline.length === 0) {
        spoken = `${child.nickname} is ${STAGE_LABELS[stage]} now. I re-checked the home and nothing needs attention.`;
      } else {
        const needsSupplies = open.some((f) => f.supplies.length > 0);
        spoken =
          `${observed ? 'Big milestone! ' : ''}${child.nickname} is ${STAGE_LABELS[stage]} now, so I re-checked the home. ` +
          `${capitalize(countPhrase(open.length, 'thing'))} need${open.length === 1 ? 's' : ''} attention${headline.length < open.length ? ', starting with' : ':'} ${listPhrase(headline.map((f) => f.title.charAt(0).toLowerCase() + f.title.slice(1)))}. ` +
          `The room-by-room plan is on screen.${needsSupplies ? ' Want me to get the supplies?' : ''}`;
      }
      return {
        spoken,
        data: {
          child: {
            nickname: child.nickname,
            stage,
            stageLabel: STAGE_LABELS[stage],
            previousStage: previous ?? null,
            ageMonths: child.birthMonth ? Math.floor(ageInMonths(child.birthMonth, now)) : null,
          },
          changed,
          nextStage: nextStage(stage) ?? null,
          ...this.planData(h, stage, findings, false),
          newThisStage: fresh.map((f) => f.title),
        },
      };
    });
  }

  addItems(input: { items: ItemInput[] }) {
    if (!input.items.length) return { isError: true, spoken: 'Tell me which items to add.', data: { error: 'empty' } };
    const visible = this.visible();
    return this.deps.store.update((h) => {
      const added: Item[] = [];
      const alerts: { item: Item; hit: RecallHit; match: RecallMatch }[] = [];
      for (const input1 of input.items) {
        const item = this.createItem(input1);
        h.items.push(item);
        added.push(item);
        for (const r of input1.room ? [input1.room] : []) if (!h.rooms.includes(r)) h.rooms.push(r);
        const hits = findRecallHits(item, visible);
        const matches = this.recordHits(h, item, hits);
        for (const m of matches) {
          const hit = hits.find((x) => x.recall.recallNumber === m.recallNumber)!;
          if (hit.confidence !== 'possible') alerts.push({ item, hit, match: m });
        }
      }
      let spoken = `Added ${listPhrase(added.map((i) => `the ${i.name}`))}.`;
      const top = alerts[0];
      if (top) {
        spoken += ` One heads-up: the ${top.item.name} ${top.hit.confidence === 'confirmed' ? 'matches' : 'may match'} a ${top.hit.recall.recallDate.slice(0, 4)} recall for a ${this.view(top.hit.recall).hazardShort}. Details are on screen.`;
      }
      return {
        spoken,
        data: {
          added: added.map((i) => ({ id: i.id, name: i.name, category: i.category, room: i.room ?? null })),
          recalls: alerts.map((a) => this.view(a.hit.recall, a.item, a.match)),
          noticesSearched: visible.length,
        },
      };
    });
  }

  checkSecondhandItem(input: ItemInput & { register?: boolean }) {
    const visible = this.visible();
    const label = (input.name ?? CATEGORIES[input.category].label).toLowerCase().replace(/^(an?|the|my|our)\s+/, '');
    const banned = this.deps.rules.secondhand.find((r) => r.categories.includes(input.category));
    const probe = this.createItem({ ...input, source: input.source ?? 'hand_me_down' });
    const hits = findRecallHits(probe, visible);
    const top = hits[0];
    const reasons: { text: string; source?: string }[] = [];
    const questions: string[] = [];
    let verdict: 'use' | 'fix_first' | 'do_not_use' | 'need_info' = 'use';
    let recall: RecallView | undefined;

    if (banned) {
      verdict = banned.verdict;
      reasons.push({ text: banned.reason, source: banned.sources[0]?.url });
    }
    if (top) {
      recall = this.view(top.recall, probe);
      if (top.confidence === 'confirmed') {
        verdict = recall.stopUsing === 'yes' ? 'do_not_use' : verdict === 'do_not_use' ? verdict : 'fix_first';
        reasons.push({ text: `Matches a federal recall for a ${recall.hazardShort}.`, source: top.recall.url });
      } else {
        if (verdict === 'use') verdict = 'fix_first';
        reasons.push({ text: `May match a federal recall for a ${recall.hazardShort}.`, source: top.recall.url });
        if (!input.model) questions.push(`What model number is on the ${label}'s label?`);
      }
    } else if (!input.model && categoryHasRecalls(input.category, visible)) {
      questions.push(`What model number is on the ${label}'s label?`);
    }
    if (input.category === 'crib' && verdict !== 'do_not_use') {
      if (input.hasBumpers === undefined) questions.push('Does it come with bumper pads?');
      else if (input.hasBumpers) {
        const rule = this.deps.rules.home.find((r) => r.id === 'remove-bumpers');
        if (verdict === 'use') verdict = 'fix_first';
        reasons.push({ text: 'Padded crib bumpers are banned under federal law. Leave them out.', source: rule?.sources[0]?.url });
      }
    }
    if (input.category === 'window_covering' && input.corded !== false && verdict === 'use') {
      verdict = 'fix_first';
      reasons.push({ text: 'Long cords need to go up out of reach.' });
    }
    if (verdict === 'use' && questions.length) verdict = 'need_info';

    let item: Item | undefined;
    if (verdict !== 'need_info' && input.register !== false) {
      item = this.deps.store.update((h) => {
        const existing = h.items.find((i) => i.status === 'active' && i.category === probe.category && i.source !== 'owned' && !i.model && !!probe.model);
        const it = existing ? Object.assign(existing, { model: probe.model, brand: probe.brand ?? existing.brand, hasBumpers: probe.hasBumpers ?? existing.hasBumpers }) : probe;
        if (input.hasBumpers) it.hasBumpers = true;
        if (verdict === 'do_not_use') it.doNotUse = true;
        if (!existing) h.items.push(it);
        if (it.room && !h.rooms.includes(it.room)) h.rooms.push(it.room);
        this.recordHits(h, it, hits.filter((x) => x.confidence !== 'possible'));
        return it;
      });
    }

    let spoken: string;
    switch (verdict) {
      case 'do_not_use':
        spoken = recall
          ? `Please don't use that ${label}. It matches a ${recall.monthYear} federal recall for a ${recall.hazardShort}. The fix is ${remedyPhrase(top!.recall)}, and the steps are on screen.`
          : `Please don't use that ${label}. ${reasons[0]?.text ?? ''}`.trim();
        break;
      case 'fix_first':
        spoken =
          top && top.confidence !== 'confirmed'
            ? `That ${label} may be part of a ${recall!.monthYear} recall for a ${recall!.hazardShort}. ${questions[0] ?? 'Check its label against the notice on screen.'}`
            : `${top ? `No recall stops you, but` : `No recalls match that ${label}, so it can stay, but`} ${reasons.map((r) => r.text.charAt(0).toLowerCase() + r.text.slice(1)).join(' ')}`;
        if (input.category === 'crib' && input.hasBumpers) spoken += ' Keep it bare: just a fitted sheet.';
        break;
      case 'need_info':
        spoken = `I can check that ${label}. ${questions.join(' ')}`;
        break;
      default:
        spoken = `Good news: no recalls match that ${label}${input.model ? ` model` : ''}, so it's fine to use.`;
        if (input.category === 'crib') spoken += ' Keep it bare: just a fitted sheet.';
    }
    return {
      spoken,
      data: {
        verdict,
        item: { name: label, category: input.category, model: input.model ?? null, registered: !!item },
        reasons,
        questions,
        recall: recall ?? null,
        noticesSearched: visible.length,
      },
    };
  }

  /** Re-match every active item against visible recalls. Used by check_recalls and the scheduler. */
  sweep(notify: boolean): { added: RecallMatch[]; alerts: Alert[] } {
    const visible = this.visible();
    const result = this.deps.store.update((h) => {
      const added: RecallMatch[] = [];
      const alerts: Alert[] = [];
      for (const item of h.items.filter((i) => i.status === 'active')) {
        const hits = findRecallHits(item, visible).filter((x) => x.confidence !== 'possible');
        for (const m of this.recordHits(h, item, hits)) {
          added.push(m);
          if (!notify) continue;
          const rec = this.deps.index.get(m.recallNumber)!;
          const v = this.view(rec, item, m);
          const where = item.room ? ` in the ${item.room}` : '';
          const keep = v.stopUsing === 'if_not_anchored' && item.anchored ? ` Since you anchored it, it can stay in use for now.` : v.stopUsing === 'yes' ? ' Stop using it for now.' : '';
          alerts.push(
            this.addAlert(h, {
              kind: 'recall',
              title: `New recall: ${item.name}${where}`,
              spoken: `Heads up: a recall just came out that ${m.confidence === 'confirmed' ? 'matches' : 'may match'} the ${item.name}${where}, for a ${v.hazardShort}.${keep} Ask me what to do next.`,
              recallNumber: m.recallNumber,
              itemId: item.id,
            }),
          );
        }
      }
      for (const child of h.children) {
        const stage = effectiveStage(child, this.now());
        if (notify && child.lastAuditedStage && stage !== child.lastAuditedStage) {
          alerts.push(
            this.addAlert(h, {
              kind: 'stage',
              title: `${child.nickname} may be ${STAGE_LABELS[stage]} soon`,
              spoken: `${child.nickname} is at the age when many babies start ${STAGE_LABELS[stage]}. Want me to re-check the home for that?`,
            }),
          );
          child.lastAuditedStage = stage;
        }
      }
      return { added, alerts };
    });
    if (result.alerts.length) this.deps.onAlertsChanged?.();
    return result;
  }

  checkRecalls(_input: { onlyNew?: boolean }) {
    const before = this.household().lastRecallCheckAt;
    this.sweep(false);
    const visible = this.visible();
    const h = this.deps.store.update((hh) => {
      hh.lastRecallCheckAt = this.now().toISOString();
      this.markRecallAlertsRead(hh);
      return hh;
    });
    this.deps.onAlertsChanged?.();
    const items = h.items.filter((i) => i.status === 'active');
    const open = h.recallMatches
      .filter((m) => m.remedyStatus !== 'resolved' && (!_input.onlyNew || !before || m.firstSeenAt > before))
      .sort((a, b) => {
        const an = !before || a.firstSeenAt > before ? 0 : 1;
        const bn = !before || b.firstSeenAt > before ? 0 : 1;
        return an - bn || (a.confidence === b.confidence ? 0 : a.confidence === 'confirmed' ? -1 : 1);
      })
      .slice(0, 5);
    const views = open.map((m) => {
      const item = h.items.find((i) => i.id === m.itemId);
      return { ...this.view(this.deps.index.get(m.recallNumber)!, item, m), isNew: !before || m.firstSeenAt > before };
    });
    let spoken: string;
    if (!views.length) {
      spoken = `I checked your ${countPhrase(items.length, 'item')} against ${visible.length} federal recall notices. Nothing matches.`;
    } else {
      const first = views[0];
      spoken =
        `${capitalize(countPhrase(views.length, 'recall'))} on your list${views.some((v) => v.isNew) ? `, ${views.filter((v) => v.isNew).length} new` : ''}. ` +
        `Most important: the ${first.itemName}, for a ${first.hazardShort}. ${first.stopUsing === 'yes' && first.remedyStatus === 'open' ? 'Stop using it. ' : ''}Details are on screen.`;
    }
    return { spoken, data: { checkedItems: items.length, noticesSearched: visible.length, matches: views } };
  }

  private findMatch(h: Household, recall?: string, item?: string): RecallMatch | undefined {
    const open = h.recallMatches.filter((m) => m.remedyStatus !== 'resolved');
    if (recall && recall !== 'latest') return h.recallMatches.find((m) => m.recallNumber === recall);
    if (item) {
      const words = keywords(item);
      const hit = open.find((m) => {
        const it = h.items.find((i) => i.id === m.itemId);
        return it && words.some((w) => it.name.includes(w) || it.category.includes(w));
      });
      if (hit) return hit;
    }
    return [...open].sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1))[0];
  }

  getRecallGuidance(input: { recallNumber?: string; item?: string }) {
    return this.deps.store.update((h) => {
      const m = this.findMatch(h, input.recallNumber, input.item);
      if (!m) {
        return { isError: true, spoken: "I don't have an open recall for that. Ask me to check for recalls first.", data: { error: 'no_match' } };
      }
      const item = h.items.find((i) => i.id === m.itemId);
      const rec = this.deps.index.get(m.recallNumber)!;
      const v = this.view(rec, item, m);
      this.markRecallAlertsRead(h, m.recallNumber);
      const name = item?.name ?? 'item';
      let spoken: string;
      if (v.stopUsing === 'if_not_anchored') {
        spoken = `${v.personalNote} The company is offering ${remedyPhrase(rec)}. Contact them to request it; their details are on screen.`;
      } else if (v.stopUsing === 'yes') {
        spoken = `Stop using the ${name} now and keep it away from the baby. The company is offering ${remedyPhrase(rec)}. Their contact details and the steps are on screen.`;
      } else {
        spoken = `The company is offering ${remedyPhrase(rec)} for the ${name}. The steps and contact details are on screen.`;
      }
      if (m.remedyStatus === 'requested') spoken = `You've already asked for ${remedyPhrase(rec)} for the ${name}. ${v.personalNote ?? ''}`.trim();
      return { spoken, data: { recall: v } };
    });
  }

  private openFindings(h: Household, findings: Finding[]): Finding[] {
    return findings.filter((f) => !h.tasks.some((t) => t.ruleId === f.ruleId && t.itemId === f.itemId && t.status === 'done'));
  }

  private planData(h: Household, stage: Stage, findings: Finding[], isPreview: boolean) {
    const open = this.openFindings(h, findings);
    const roomNames = [...new Set(open.map((f) => f.room))];
    const done = h.tasks.filter((t) => t.kind === 'hazard' && t.status === 'done');
    return {
      stage,
      stageLabel: STAGE_LABELS[stage],
      isPreview,
      openCount: open.length,
      rooms: roomNames.map((room) => ({
        room,
        findings: open
          .filter((f) => f.room === room)
          .map((f) => ({
            title: f.title,
            hazard: f.hazard,
            action: f.action,
            priority: f.priority,
            newThisStage: f.newThisStage,
            supplies: f.supplies,
            sources: f.sources,
            task: h.tasks.find((t) => t.ruleId === f.ruleId && t.itemId === f.itemId) ?? null,
          })),
      })),
      done: done.map((t) => ({ title: t.title, room: t.room ?? null, completedAt: t.completedAt ?? null })),
      upcoming: h.tasks
        .filter((t) => t.status === 'open' && t.dueAt)
        .sort((a, b) => (a.dueAt! < b.dueAt! ? -1 : 1))
        .map((t) => ({ title: t.title, dueAt: t.dueAt!, when: formatWhen(t.dueAt!) })),
    };
  }

  getSafetyPlan(input: { stage?: Stage | 'next'; nickname?: string }) {
    return this.deps.store.update((h) => {
      const child = this.child(h, input.nickname);
      if (!child) return { isError: true, spoken: "Tell me about your child first, like their nickname and birth month.", data: { error: 'no_child' } };
      const current = effectiveStage(child, this.now());
      const target = input.stage === 'next' ? nextStage(current) ?? current : input.stage ?? current;
      const isPreview = target !== current;
      const findings = findingsFor(h, target, this.deps.rules);
      if (!isPreview) this.ensureTasks(h, findings);
      const data = this.planData(h, target, findings, isPreview);
      const open = this.openFindings(h, findings);
      let spoken: string;
      if (isPreview) {
        const fresh = open.filter((f) => f.newThisStage);
        spoken =
          `${capitalize(STAGE_LABELS[target])} comes next. ` +
          (fresh.length
            ? `When it starts, ${listPhrase(fresh.slice(0, 3).map((f) => f.title.charAt(0).toLowerCase() + f.title.slice(1)))}. `
            : `Nothing new gets added to the list for it. `) +
          (open.length - fresh.length > 0 ? `${capitalize(countPhrase(open.length - fresh.length, 'item'))} from today's list ${open.length - fresh.length === 1 ? 'is' : 'are'} still open.` : `Everything from today's list is done, so you're ready.`);
      } else if (!open.length) {
        spoken = `Your home is in good shape for ${STAGE_LABELS[target]}. Everything on the list is done.`;
      } else {
        spoken = `For ${STAGE_LABELS[target]}, ${countPhrase(open.length, 'thing')} ${open.length === 1 ? 'is' : 'are'} open: ${listPhrase(open.slice(0, 3).map((f) => f.title.charAt(0).toLowerCase() + f.title.slice(1)))}. The plan is on screen.`;
      }
      return { spoken, data: { child: { nickname: child.nickname, stage: current }, ...data } };
    });
  }

  prepareSupplyOrder(input: { skus?: string[] }) {
    const catalog = this.deps.catalog;
    return this.deps.store.update((h) => {
      const alreadyOrdered = new Set(h.orders.filter((o) => o.status === 'confirmed').flatMap((o) => o.lines.map((l) => l.sku)));
      const counts = new Map<string, number>();
      if (input.skus?.length) {
        for (const s of input.skus) counts.set(s, (counts.get(s) ?? 0) + 1);
      } else {
        for (const t of h.tasks.filter((t) => t.status === 'open' && t.ruleId)) {
          const rule = this.deps.rules.home.find((r) => r.id === t.ruleId);
          for (const sku of rule?.supplies ?? []) {
            if (alreadyOrdered.has(sku)) continue;
            const p = catalog.products.find((x) => x.sku === sku);
            if (!p) continue;
            counts.set(sku, p.perItem ? (counts.get(sku) ?? 0) + 1 : 1);
          }
        }
      }
      const unknown = [...counts.keys()].filter((s) => !catalog.products.some((p) => p.sku === s));
      if (unknown.length) return { isError: true, spoken: "The demo store doesn't carry that.", data: { error: 'unknown_sku', unknown } };
      if (!counts.size) return { spoken: 'Your plan doesn’t need any supplies right now.', data: { order: null } };
      const lines = [...counts].map(([sku, qty]) => {
        const p = catalog.products.find((x) => x.sku === sku)!;
        return { sku, name: p.name, qty, unitPrice: p.price };
      });
      const total = Math.round(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0) * 100) / 100;
      const now = this.now();
      const order: Order = {
        id: newId('ord'),
        token: randomBytes(6).toString('hex'),
        lines,
        total,
        status: 'prepared',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ORDER_TTL_MS).toISOString(),
      };
      h.orders.push(order);
      const names = lines.map((l) => `${l.qty > 1 ? `${countPhrase(l.qty, '').trim()} ` : ''}${l.name.replace(/\s*\(.*\)$/, '').replace(/^[A-Z][a-z]/, (c) => c.toLowerCase())}${l.qty > 1 ? 's' : ''}`);
      return {
        // A spoken list longer than two items is hard to follow; the cart on screen carries the details.
        spoken:
          names.length <= 2
            ? `From the demo store: ${listPhrase(names)}. That's ${money(total)}. Should I place the order?`
            : `From the demo store: ${countPhrase(names.length, 'safety item')} for ${money(total)}, listed on screen. Should I place the order?`,
        data: { order: this.orderView(order) },
      };
    });
  }

  private orderView(o: Order) {
    return { token: o.token, lines: o.lines, total: o.total, status: o.status, expiresAt: o.expiresAt, demoStore: true as const };
  }

  confirmSupplyOrder(input: { token: string }) {
    return this.deps.store.update((h) => {
      const o = h.orders.find((x) => x.token === input.token);
      if (!o) return { isError: true, spoken: "I couldn't find that cart. Ask me to set it up again.", data: { error: 'unknown_token' } };
      if (o.status === 'confirmed') {
        return { spoken: `That order is already placed, ${money(o.total)}. I won't order it twice.`, data: { order: this.orderView(o), alreadyConfirmed: true } };
      }
      if (new Date(o.expiresAt) < this.now()) {
        return { isError: true, spoken: 'That cart expired. Ask me to set it up again so the prices are current.', data: { error: 'expired' } };
      }
      o.status = 'confirmed';
      o.confirmedAt = this.now().toISOString();
      return {
        spoken: `Order placed: ${money(o.total)}. This is a demo store, so nothing was charged.`,
        data: { order: this.orderView(o), alreadyConfirmed: false },
      };
    });
  }

  updateTask(input: { task?: string; action?: 'complete' | 'schedule' | 'snooze' | 'reopen'; when?: string; recall?: string; remedyStatus?: Exclude<RemedyStatus, 'open'> }) {
    return this.deps.store.update((h) => {
      if (input.remedyStatus) {
        const m = this.findMatch(h, input.recall, input.task);
        if (!m) return { isError: true, spoken: "I don't have an open recall to update.", data: { error: 'no_match' } };
        const item = h.items.find((i) => i.id === m.itemId);
        const rec = this.deps.index.get(m.recallNumber)!;
        m.remedyStatus = input.remedyStatus;
        m.remedyUpdatedAt = this.now().toISOString();
        let spoken: string;
        if (input.remedyStatus === 'requested') {
          const due = new Date(this.now().getTime() + 14 * 864e5).toISOString().slice(0, 10) + 'T09:00';
          h.tasks.push({
            id: newId('tk'),
            title: `Check that the ${item?.name ?? 'recall'} fix arrived`,
            kind: 'recall',
            recallNumber: m.recallNumber,
            itemId: m.itemId,
            room: item?.room,
            dueAt: due,
            status: 'open',
            createdAt: this.now().toISOString(),
          });
          spoken = `Got it. I've noted that you asked for ${remedyPhrase(rec)} for the ${item?.name ?? 'item'}. I'll check with you in two weeks that it arrived.`;
        } else {
          for (const t of h.tasks.filter((t) => t.recallNumber === m.recallNumber && t.status === 'open')) {
            t.status = 'done';
            t.completedAt = this.now().toISOString();
          }
          spoken = `Great, I've closed the recall on the ${item?.name ?? 'item'}.`;
        }
        return { spoken, data: { recall: { recallNumber: m.recallNumber, item: item?.name ?? null, remedyStatus: m.remedyStatus } } };
      }

      const action = input.action ?? 'complete';
      const words = keywords(input.task ?? '');
      const pool = h.tasks.filter((t) => (action === 'reopen' ? t.status === 'done' : t.status === 'open'));
      // Score each task by how many of the user's words it shares. Completing can tick off several
      // ("we anchored the dresser and the TV"); scheduling picks the single best match.
      const scored = pool
        .map((t) => ({ t, score: t.id === input.task ? 99 : words.filter((w) => keywords(`${t.title} ${t.room ?? ''}`).includes(w)).length }))
        .filter((s) => !input.task || s.score > 0)
        .sort((a, b) => b.score - a.score);
      const targets = action === 'complete' && input.task ? scored.map((s) => s.t) : scored.slice(0, 1).map((s) => s.t);
      if (!targets.length) return { isError: true, spoken: "I couldn't find that on your list.", data: { error: 'no_task' } };

      const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
      let spoken: string;
      switch (action) {
        case 'complete':
          for (const t of targets) {
            t.status = 'done';
            t.completedAt = this.now().toISOString();
            const rule = this.deps.rules.home.find((r) => r.id === t.ruleId);
            const item = h.items.find((i) => i.id === t.itemId);
            if (rule && item) Object.assign(item, rule.onComplete);
          }
          spoken = `Nice work. I've checked off ${listPhrase(targets.map((t) => lower(t.title)))}.`;
          break;
        case 'schedule': {
          if (!input.when) return { isError: true, spoken: 'When should I schedule it?', data: { error: 'no_time' } };
          for (const t of targets) t.dueAt = input.when;
          spoken = `Done. "${targets[0].title}" is on your calendar for ${formatWhen(input.when)}.`;
          break;
        }
        case 'snooze':
          for (const t of targets) {
            const base = t.dueAt ? new Date(`${t.dueAt}:00Z`) : this.now();
            t.dueAt = new Date(base.getTime() + 7 * 864e5).toISOString().slice(0, 16);
          }
          spoken = `Okay, I moved ${lower(targets[0].title)} to ${formatWhen(targets[0].dueAt!)}.`;
          break;
        case 'reopen':
          for (const t of targets) {
            t.status = 'open';
            t.completedAt = undefined;
          }
          spoken = `I put ${lower(targets[0].title)} back on your list.`;
          break;
      }
      return { spoken, data: { tasks: targets.map((t) => ({ title: t.title, status: t.status, dueAt: t.dueAt ?? null })) } };
    });
  }

  // ---------------------------------------------------------------- resources

  householdSummary() {
    const h = this.household();
    const now = this.now();
    return {
      now: now.toISOString(),
      simulatedClock: this.deps.clock.isSimulated(),
      children: h.children.map((c) => ({ nickname: c.nickname, stage: effectiveStage(c, now), stageLabel: STAGE_LABELS[effectiveStage(c, now)] })),
      items: h.items.filter((i) => i.status === 'active').map((i) => ({ name: i.name, category: i.category, room: i.room ?? null, source: i.source, anchored: i.anchored ?? null })),
      openTasks: h.tasks.filter((t) => t.status === 'open').map((t) => ({ title: t.title, room: t.room ?? null, dueAt: t.dueAt ?? null, when: t.dueAt ? formatWhen(t.dueAt) : null })),
      openRecalls: h.recallMatches
        .filter((m) => m.remedyStatus !== 'resolved')
        .map((m) => ({ item: h.items.find((i) => i.id === m.itemId)?.name ?? null, recallNumber: m.recallNumber, confidence: m.confidence, remedyStatus: m.remedyStatus })),
      orders: h.orders.filter((o) => o.status === 'confirmed').map((o) => ({ total: o.total, lines: o.lines.length, confirmedAt: o.confirmedAt })),
    };
  }

  alerts() {
    const h = this.household();
    return { unread: h.alerts.filter((a) => !a.read), recent: h.alerts.slice(0, 10) };
  }
}
