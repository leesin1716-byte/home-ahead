// 발달 단계 엔진: 생년월로 기본 단계를 정하고, 부모가 관찰한 단계가 더 앞서면 그것을 따른다
import { STAGES, type Child, type Stage } from './types.js';

export const STAGE_LABELS: Record<Stage, string> = {
  newborn: 'newborn',
  rolling: 'rolling over',
  sitting: 'sitting up',
  crawling: 'crawling',
  cruising: 'pulling up and cruising',
  walking: 'walking',
  climbing: 'climbing',
};

/**
 * Rough age defaults in months. Children vary a lot; these only set a starting point, and
 * what a parent observes always wins when it is further along.
 */
const AGE_DEFAULTS: [number, Stage][] = [
  [0, 'newborn'],
  [3, 'rolling'],
  [5, 'sitting'],
  [8, 'crawling'],
  [10, 'cruising'],
  [12, 'walking'],
  [18, 'climbing'],
];

export function stageIndex(s: Stage): number {
  return STAGES.indexOf(s);
}

export function nextStage(s: Stage): Stage | undefined {
  return STAGES[stageIndex(s) + 1];
}

export function ageInMonths(birthMonth: string, now: Date): number {
  const [y, m] = birthMonth.split('-').map(Number);
  // Assume mid-month birth; good enough for a default.
  const born = Date.UTC(y, m - 1, 15);
  return (now.getTime() - born) / (1000 * 60 * 60 * 24 * 30.4375);
}

export function defaultStageForAge(months: number): Stage {
  let stage: Stage = 'newborn';
  for (const [min, s] of AGE_DEFAULTS) if (months >= min) stage = s;
  return stage;
}

/**
 * The stage we plan for: the parent's observation, or the age default if that is further
 * along. Planning one stage "too early" is the safe direction for a home check.
 */
export function effectiveStage(child: Child, now: Date): Stage {
  const byAge = child.birthMonth ? defaultStageForAge(ageInMonths(child.birthMonth, now)) : 'newborn';
  if (!child.observedStage) return byAge;
  return stageIndex(child.observedStage) >= stageIndex(byAge) ? child.observedStage : byAge;
}

/** Map a parent's words ("she pulled herself up on the couch") to a stage. */
export function stageFromMilestone(text: string): Stage | undefined {
  const t = text.toLowerCase();
  const rules: [RegExp, Stage][] = [
    [/\bclimb(s|ed|ing)?\b/, 'climbing'],
    [/\b(walk(s|ed|ing)?|first steps?|took (a|her|his|their) (first )?steps?)\b/, 'walking'],
    [/\b(pull(s|ed|ing)? (her|him|them)sel(f|ves) up|pull(s|ed|ing)? up|cruis(e|es|ed|ing)|stand(s|ing)? up|stood up)\b/, 'cruising'],
    [/\bcrawl(s|ed|ing)?\b/, 'crawling'],
    [/\bsit(s|ting)? up\b|\bsat up\b|\bsitting\b/, 'sitting'],
    [/\broll(s|ed|ing)? over\b|\brolling\b/, 'rolling'],
  ];
  for (const [re, stage] of rules) if (re.test(t)) return stage;
  if ((STAGES as readonly string[]).includes(t.trim())) return t.trim() as Stage;
  return undefined;
}
