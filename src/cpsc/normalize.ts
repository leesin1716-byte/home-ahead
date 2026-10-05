// CPSC Recalls API 응답을 다듬어 저장용 레코드로 만들고, 브랜드·모델·분류를 뽑아내는 모듈
import { detectCategories, type CategoryId } from '../domain/categories.js';

/** Shape of one record from saferproducts.gov/RestWebServices/Recall (fields we use). */
export interface CpscApiRecall {
  RecallID: number;
  RecallNumber: string;
  RecallDate: string;
  LastPublishDate?: string;
  Title: string;
  Description: string;
  URL: string;
  ConsumerContact?: string;
  Products?: { Name?: string; Model?: string; Type?: string; NumberOfUnits?: string }[];
  Manufacturers?: { Name?: string }[];
  Importers?: { Name?: string }[];
  Distributors?: { Name?: string }[];
  Hazards?: { Name?: string }[];
  Remedies?: { Name?: string }[];
  RemedyOptions?: { Option?: string }[];
  Injuries?: { Name?: string }[];
}

/**
 * What we store in the snapshot. Product photos are deliberately dropped: they may be
 * company-supplied images, so we neither store nor display them.
 */
export interface StoredRecall {
  recallNumber: string;
  recallId: number;
  recallDate: string; // YYYY-MM-DD
  title: string;
  description: string;
  url: string;
  consumerContact: string;
  products: { name: string; model: string; type: string; units: string }[];
  companies: string[];
  hazards: string[];
  remedies: string[];
  remedyOptions: string[];
  injuries: string[];
}

/** A stored recall plus fields derived at load time (so derivation can improve without re-fetching). */
export interface RecallRecord extends StoredRecall {
  categories: CategoryId[];
  models: string[]; // normalized model / SKU codes
  brandText: string; // normalized text that brand names are matched against
  brandNames: string[]; // display-only guesses
}

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();

export function trimApiRecall(r: CpscApiRecall): StoredRecall {
  const names = (xs?: { Name?: string }[]) => (xs ?? []).map((x) => clean(x.Name)).filter(Boolean);
  return {
    recallNumber: clean(r.RecallNumber),
    recallId: r.RecallID,
    recallDate: clean(r.RecallDate).slice(0, 10),
    title: clean(r.Title),
    description: clean(r.Description),
    url: clean(r.URL),
    consumerContact: clean(r.ConsumerContact),
    products: (r.Products ?? []).map((p) => ({
      name: clean(p.Name),
      model: clean(p.Model),
      type: clean(p.Type),
      units: clean(p.NumberOfUnits),
    })),
    companies: [...names(r.Manufacturers), ...names(r.Importers), ...names(r.Distributors)],
    hazards: names(r.Hazards),
    remedies: names(r.Remedies),
    remedyOptions: (r.RemedyOptions ?? []).map((o) => clean(o.Option)).filter(Boolean),
    injuries: names(r.Injuries),
  };
}

/** Upper-case letters and digits only: "LDQMFJ8D-WH" -> "LDQMFJ8DWH". */
export function normalizeModel(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Lower-case words separated by single spaces, for brand matching. */
export function normalizeWords(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

const CODE = /[A-Z0-9][A-Z0-9\-./]{2,}[A-Z0-9]/g;

function looksLikeCode(token: string): boolean {
  return /[0-9]/.test(token) && /[A-Z]/.test(token) && !/^\d+(\.\d+)?(IN|LB|LBS|FT|MM|CM)$/.test(token);
}

/**
 * Model numbers, SKUs and product numbers mentioned in a notice. CPSC writes them in many
 * ways: "Model No.: TB-HC6900", "SKU “LDQMFJ8D-BR,” ...", "(model YJ-3355)", "Product No.: HA-028".
 */
export function extractModels(rec: StoredRecall): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    for (const m of raw.toUpperCase().match(CODE) ?? []) {
      if (looksLikeCode(m)) out.add(normalizeModel(m));
    }
  };
  for (const p of rec.products) if (p.model) add(p.model);
  const text = rec.description;
  // After an identifier keyword, up to the end of the sentence.
  const keyword = /(model|sku|product|item|style|part|catalog|lot)\s*(no\.?|nos\.?|numbers?|#|names?)?\s*[:\s]/gi;
  let m: RegExpExecArray | null;
  while ((m = keyword.exec(text))) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 160);
    add(rest.split(/(?<!\b(?:No|Nos))\.\s/)[0] ?? rest);
  }
  // Anything inside quotes that looks like a code.
  for (const q of text.match(/["“”']([^"“”']{3,40})["“”']/g) ?? []) add(q);
  return [...out];
}

const COMPANY_NOISE = /\b(inc|llc|ltd|co|corp|corporation|company|limited|group|store|direct|trading|technology|products|international|of|dba|the|and)\b/g;

function brandCandidates(rec: StoredRecall): string[] {
  const out = new Set<string>();
  const t = rec.title;
  const recalls = t.match(/^(.+?) (Recalls|Reannounces|Expands|Announces)\b/);
  if (recalls) out.add(recalls[1]);
  const recalled = t.match(/^(.+?) Recalled\b/);
  if (recalled) out.add(recalled[1]);
  for (const c of rec.companies) {
    const dba = c.match(/dba ([^,]+)/i);
    out.add((dba ? dba[1] : c.split(',')[0]).trim());
  }
  return [...out].filter(Boolean);
}

export function deriveRecord(rec: StoredRecall): RecallRecord {
  const productText = rec.products.map((p) => `${p.name} ${p.type}`).join(' ');
  const categories = detectCategories(`${rec.title} ${productText}`);
  const brandNames = brandCandidates(rec);
  const brandText = normalizeWords(
    [rec.title, productText, rec.description.slice(0, 300), ...rec.companies].join(' '),
  );
  return { ...rec, categories, models: extractModels(rec), brandText, brandNames };
}

/** True when every word of the brand appears, in order, in the recall's brand text. */
export function brandMatches(brand: string, rec: RecallRecord): boolean {
  const b = normalizeWords(brand).replace(COMPANY_NOISE, ' ').replace(/\s+/g, ' ');
  if (b.trim().length < 2) return false;
  return rec.brandText.includes(b);
}

/**
 * Lower-case words that appear in the prose of at least `minRecalls` different notices.
 * Brand names almost never pass this test; ordinary words ("dressers", "serious") do.
 */
export function buildGenericVocabulary(records: StoredRecall[], minRecalls = 3): Set<string> {
  const counts = new Map<string, number>();
  for (const r of records) {
    const prose = [r.description, ...r.hazards, ...r.remedies, ...r.injuries]
      .join(' ')
      .replace(/\S+@\S+|https?:\/\/\S+|www\.\S+/g, ' ');
    const seen = new Set(prose.match(/\b[a-z][a-z'-]+\b/g) ?? []);
    for (const w of seen) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const vocab = new Set<string>();
  for (const [w, n] of counts) if (n >= minRecalls) vocab.add(w);
  for (const w of ['recalls', 'recalled', 'reannounces', 'expands', 'due', 'violate', 'violates', 'mandatory', 'federal', 'rule', 'ban', 'alert', 'sold', 'exclusively', 'brand', 'branded', 'multiple', 'brands', 'and', 'the', 'of', 'for', 'with', 'by', 'at', 'on', 'in', 'to', 'from', 'or', 'inc', 'llc', 'ltd', 'corp', 'co', 'corporation', 'company', 'dba', 'china', 'clothing', 'changing', 'storage', 'products', 'store', 'technology', 'convertible', 'braided', 'distributed', 'post-recall']) vocab.add(w);
  return vocab;
}

/** Capitalised words from the title, product names and companies that are not ordinary words. */
export function brandWords(rec: StoredRecall, vocab: Set<string>): string[] {
  const source = [rec.title, ...rec.products.map((p) => p.name), ...rec.companies].join(' ');
  const words = new Set<string>();
  for (const raw of source.split(/[\s,;:()]+/)) {
    const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+&]+$/g, '');
    if (w.length < 3 || !/^[A-Z]/.test(w) || /^\d/.test(w)) continue;
    const parts = w.toLowerCase().split('-');
    if (parts.every((x) => vocab.has(x) || /^\d/.test(x))) continue;
    words.add(w);
  }
  return [...words];
}

/** Replace brand names with a neutral phrase (used in "video-safe" mode). */
export function redactBrands(text: string, words: string[], replacement = 'the company'): string {
  let out = text;
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), replacement);
  }
  return out.replace(new RegExp(`(${replacement})(\\s+${replacement})+`, 'g'), '$1');
}
