// 위험 규칙(data/rules/hazards.json)을 읽어 검증하고, 단계·물건에 맞는 점검 결과를 계산한다
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CATEGORY_IDS } from './categories.js';
import { STAGES, type Household, type Item, type Stage } from './types.js';
import { stageIndex } from './stages.js';

const SourceSchema = z.union([
  z.object({
    kind: z.literal('cpsc-recall'),
    recallNumber: z.string().min(1),
    url: z.string().url(),
    quote: z.string().min(10),
  }),
  z.object({
    kind: z.literal('gov-page'),
    url: z.string().url(),
    quote: z.string().min(10),
    checkedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

const Condition = z.enum(['true', 'not_true', 'false', 'not_false']);

const HomeRuleSchema = z.object({
  id: z.string(),
  title: z.string().includes('{item}'),
  categories: z.array(z.enum(CATEGORY_IDS)).min(1),
  when: z.object({ anchored: Condition.optional(), corded: Condition.optional(), hasBumpers: Condition.optional() }),
  stages: z.array(z.enum(STAGES)).min(1),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  hazard: z.string(),
  action: z.string(),
  supplies: z.array(z.string()),
  onComplete: z.object({ anchored: z.boolean().optional(), corded: z.boolean().optional(), hasBumpers: z.boolean().optional() }),
  sources: z.array(SourceSchema).min(1),
});

const SecondhandRuleSchema = z.object({
  id: z.string(),
  categories: z.array(z.enum(CATEGORY_IDS)).min(1),
  verdict: z.enum(['do_not_use', 'fix_first']),
  reason: z.string(),
  sources: z.array(SourceSchema).min(1),
});

export const RuleFileSchema = z.object({
  note: z.string().optional(),
  home: z.array(HomeRuleSchema),
  secondhand: z.array(SecondhandRuleSchema),
});

export type RuleFile = z.infer<typeof RuleFileSchema>;
export type HomeRule = z.infer<typeof HomeRuleSchema>;
export type SecondhandRule = z.infer<typeof SecondhandRuleSchema>;
export type RuleSource = z.infer<typeof SourceSchema>;

export function loadRules(path: string): RuleFile {
  return RuleFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function conditionHolds(cond: z.infer<typeof Condition> | undefined, value: boolean | undefined): boolean {
  switch (cond) {
    case undefined:
      return true;
    case 'true':
      return value === true;
    case 'not_true':
      return value !== true;
    case 'false':
      return value === false;
    case 'not_false':
      return value !== false;
  }
}

export function ruleApplies(rule: HomeRule, item: Item, stage: Stage): boolean {
  return (
    item.status === 'active' &&
    !item.doNotUse &&
    rule.categories.includes(item.category) &&
    rule.stages.includes(stage) &&
    conditionHolds(rule.when.anchored, item.anchored) &&
    conditionHolds(rule.when.corded, item.corded) &&
    conditionHolds(rule.when.hasBumpers, item.hasBumpers)
  );
}

export interface Finding {
  ruleId: string;
  itemId: string;
  itemName: string;
  room: string;
  title: string;
  hazard: string;
  action: string;
  priority: number;
  supplies: string[];
  sources: { url: string; label: string }[];
  /** True when the rule did not apply at the previous stage. */
  newThisStage: boolean;
}

function sourceLabel(s: RuleSource): string {
  return s.kind === 'cpsc-recall' ? `CPSC recall notice ${s.recallNumber}` : new URL(s.url).hostname.replace(/^www\./, '');
}

export function findingsFor(household: Household, stage: Stage, rules: RuleFile): Finding[] {
  const prev = STAGES[stageIndex(stage) - 1];
  const out: Finding[] = [];
  for (const item of household.items) {
    for (const rule of rules.home) {
      if (!ruleApplies(rule, item, stage)) continue;
      out.push({
        ruleId: rule.id,
        itemId: item.id,
        itemName: item.name,
        room: item.room ?? 'Around the house',
        title: rule.title.replace('{item}', item.name),
        hazard: rule.hazard,
        action: rule.action,
        priority: rule.priority,
        supplies: rule.supplies,
        sources: rule.sources.map((s) => ({ url: s.url, label: sourceLabel(s) })),
        newThisStage: prev ? !rule.stages.includes(prev) : true,
      });
    }
  }
  return out.sort((a, b) => a.priority - b.priority || a.room.localeCompare(b.room));
}
