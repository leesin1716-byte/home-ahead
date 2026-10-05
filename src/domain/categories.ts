// 집 안 물건 분류 목록과, 문장(리콜 제목·사용자 말)에서 분류를 찾아내는 규칙

export const CATEGORY_IDS = [
  'high_chair',
  'crib',
  'crib_mattress',
  'crib_bumper',
  'bassinet',
  'play_yard',
  'stroller',
  'dresser',
  'bookcase',
  'tv',
  'window_covering',
  'baby_gate',
  'bath_seat',
  'baby_bath',
  'swing',
  'bouncer',
  'walker',
  'nursing_pillow',
  'lounger',
  'inclined_sleeper',
  'baby_monitor',
  'teether',
  'magnetic_toy',
  'bed_rail',
  'toy',
  'other',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

interface CategoryDef {
  label: string;
  plural: string;
  /** Lower-case phrases. Order of CATEGORY_MATCH_ORDER decides which wins. */
  keywords: string[];
}

export const CATEGORIES: Record<CategoryId, CategoryDef> = {
  high_chair: { label: 'high chair', plural: 'high chairs', keywords: ['high chair', 'highchair'] },
  crib: { label: 'crib', plural: 'cribs', keywords: ['crib'] },
  crib_mattress: { label: 'crib mattress', plural: 'crib mattresses', keywords: ['crib mattress', 'play yard mattress', 'playard mattress'] },
  crib_bumper: { label: 'crib bumper', plural: 'crib bumpers', keywords: ['bumper'] },
  bassinet: { label: 'bassinet', plural: 'bassinets', keywords: ['bassinet'] },
  play_yard: { label: 'play yard', plural: 'play yards', keywords: ['play yard', 'playard', 'playpen', 'play pen'] },
  stroller: { label: 'stroller', plural: 'strollers', keywords: ['stroller', 'pram'] },
  dresser: { label: 'dresser', plural: 'dressers', keywords: ['dresser', 'chest of drawers', 'clothing storage', 'drawer chest'] },
  bookcase: { label: 'bookcase', plural: 'bookcases', keywords: ['bookcase', 'bookshelf', 'book shelf', 'shelving unit'] },
  tv: { label: 'TV', plural: 'TVs', keywords: ['television', 'tv', 'flat screen', 'flat-screen'] },
  window_covering: { label: 'window blind', plural: 'window blinds', keywords: ['window covering', 'blind', 'shade', 'curtain'] },
  baby_gate: { label: 'baby gate', plural: 'baby gates', keywords: ['baby gate', 'safety gate', 'gate'] },
  bath_seat: { label: 'bath seat', plural: 'bath seats', keywords: ['bath seat'] },
  baby_bath: { label: 'baby bathtub', plural: 'baby bathtubs', keywords: ['baby bath', 'bath tub', 'bathtub', 'infant tub'] },
  swing: { label: 'baby swing', plural: 'baby swings', keywords: ['infant swing', 'baby swing', 'swing'] },
  bouncer: { label: 'bouncer', plural: 'bouncers', keywords: ['bouncer', 'rocker', 'jumper'] },
  walker: { label: 'baby walker', plural: 'baby walkers', keywords: ['walker'] },
  nursing_pillow: { label: 'nursing pillow', plural: 'nursing pillows', keywords: ['nursing pillow'] },
  lounger: { label: 'baby lounger', plural: 'baby loungers', keywords: ['lounger', 'infant support cushion'] },
  inclined_sleeper: { label: 'inclined sleeper', plural: 'inclined sleepers', keywords: ['inclined sleeper', 'incline sleeper'] },
  baby_monitor: { label: 'baby monitor', plural: 'baby monitors', keywords: ['baby monitor'] },
  teether: { label: 'teether', plural: 'teethers', keywords: ['teether', 'teething'] },
  magnetic_toy: { label: 'magnetic toy', plural: 'magnetic toys', keywords: ['magnet', 'magnetic'] },
  bed_rail: { label: 'bed rail', plural: 'bed rails', keywords: ['bed rail'] },
  toy: { label: 'toy', plural: 'toys', keywords: ['toy'] },
  other: { label: 'item', plural: 'items', keywords: [] },
};

/** More specific phrases first, so "crib bumper" is not filed under "crib". */
const CATEGORY_MATCH_ORDER: CategoryId[] = [
  'crib_bumper',
  'crib_mattress',
  'inclined_sleeper',
  'nursing_pillow',
  'lounger',
  'bed_rail',
  'high_chair',
  'bath_seat',
  'baby_bath',
  'bassinet',
  'play_yard',
  'crib',
  'stroller',
  'dresser',
  'bookcase',
  'window_covering',
  'baby_gate',
  'walker',
  'swing',
  'bouncer',
  'baby_monitor',
  'teether',
  'magnetic_toy',
  'tv',
  'toy',
];

function containsPhrase(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}(e?s)?([^a-z]|$)`, 'i').test(text);
}

/** Every category whose keywords appear in the text, most specific first. */
export function detectCategories(text: string): CategoryId[] {
  const lower = text.toLowerCase();
  const found: CategoryId[] = [];
  for (const id of CATEGORY_MATCH_ORDER) {
    if (CATEGORIES[id].keywords.some((k) => containsPhrase(lower, k))) found.push(id);
  }
  return found;
}

/** The single best category for a short phrase such as "an old high chair". */
export function detectCategory(text: string): CategoryId | undefined {
  return detectCategories(text)[0];
}

export function categoryLabel(id: CategoryId): string {
  return CATEGORIES[id].label;
}
