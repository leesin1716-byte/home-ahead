// 리콜 한 건을 화면 카드·음성용으로 요약한다(위험, 조치, 사용 중지 여부, 연락처, 브랜드 가리기)
import { redactBrands, type RecallRecord } from '../cpsc/normalize.js';
import type { RecallIndex } from '../cpsc/index.js';
import { CATEGORIES } from './categories.js';
import type { Confidence, Item, RemedyStatus } from './types.js';
import { monthYear } from './speech.js';

export type StopUsing = 'yes' | 'if_not_anchored' | 'no';

export interface RecallView {
  recallNumber: string;
  date: string;
  monthYear: string;
  heading: string;
  hazardShort: string;
  hazard: string;
  remedy: string;
  stopUsing: StopUsing;
  steps: string[];
  contact: string;
  units: string;
  injuries: string;
  sourceLabel: string;
  url: string;
  confidence?: Confidence;
  itemId?: string;
  itemName?: string;
  room?: string;
  remedyStatus?: RemedyStatus;
  /** Advice that depends on this home, e.g. the dresser is already anchored. */
  personalNote?: string;
}

function firstSentence(s: string): string {
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : s).trim();
}

/** "…Due to Risk of Serious Injury or Death from Fall and Entrapment Hazards; …" -> "fall and entrapment hazard" */
export function hazardShort(title: string): string {
  const m = title.match(/Due to (?:the )?(?:Risk of )?(?:Serious )?(?:Injury|Injuries)?(?: or Death)?(?: to Children)?(?: from| to)?\s*(.+?)(?:;|$)/i);
  let h = (m ? m[1] : 'safety hazard').trim();
  h = h.replace(/\bHazards\b/gi, 'hazard').replace(/\bHazard\b/gi, 'hazard');
  if (!/hazard/i.test(h)) h = `${h} hazard`;
  return h.toLowerCase().replace(/\s+/g, ' ');
}

export function stopUsing(rec: RecallRecord): StopUsing {
  const text = rec.remedies.join(' ');
  if (/stop using[^.]*if (they are|it is) not anchored|if (they are|it is) not anchored[^.]*stop using/i.test(text)) return 'if_not_anchored';
  if (/stop using|do not use|discontinue use/i.test(text)) return 'yes';
  return 'no';
}

function remedyLabel(rec: RecallRecord): string {
  const opt = rec.remedyOptions[0];
  if (opt) return opt;
  const t = rec.remedies.join(' ');
  if (/refund/i.test(t)) return 'Refund';
  if (/repair|retrofit|kit/i.test(t)) return 'Repair';
  if (/replace/i.test(t)) return 'Replace';
  return 'See notice';
}

export interface ViewOptions {
  videoSafe: boolean;
  item?: Item;
  confidence?: Confidence;
  remedyStatus?: RemedyStatus;
}

export function recallView(rec: RecallRecord, index: RecallIndex, opts: ViewOptions): RecallView {
  const words = opts.videoSafe ? index.brandWordsFor(rec) : [];
  const r = (s: string) =>
    opts.videoSafe
      ? redactBrands(s, words)
          .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'the email address in the notice')
          .replace(/(https?:\/\/|www\.)\S+/g, 'the website in the notice')
          .replace(/the company (Store|Products|Group|Direct)\b/g, 'the company')
      : s;
  const category = opts.item?.category ?? rec.categories[0];
  const productLabel = category ? CATEGORIES[category].label : 'product';
  const stop = stopUsing(rec);
  const steps = rec.remedies
    .join(' ')
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => r(s.trim()))
    .filter(Boolean)
    .slice(0, 4);
  let personalNote: string | undefined;
  if (stop === 'if_not_anchored' && opts.item) {
    personalNote = opts.item.anchored
      ? `Your ${opts.item.name} is anchored, so it can stay in use while you get the fix.`
      : `Your ${opts.item.name} isn't anchored yet. Move it where the baby can't reach until it is.`;
  }
  return {
    recallNumber: rec.recallNumber,
    date: rec.recallDate,
    monthYear: monthYear(rec.recallDate),
    heading: opts.videoSafe ? `${productLabel.charAt(0).toUpperCase()}${productLabel.slice(1)} recall` : rec.title,
    hazardShort: hazardShort(rec.title),
    hazard: r(firstSentence(rec.hazards[0] ?? rec.title)),
    remedy: remedyLabel(rec),
    stopUsing: stop,
    steps,
    contact: opts.videoSafe ? 'Contact details are in the official notice.' : rec.consumerContact,
    units: rec.products.map((p) => p.units).filter(Boolean).join(', '),
    injuries: r(rec.injuries.join(' ')),
    sourceLabel: `U.S. CPSC recall ${rec.recallNumber}`,
    url: rec.url,
    confidence: opts.confidence,
    itemId: opts.item?.id,
    itemName: opts.item?.name,
    room: opts.item?.room,
    remedyStatus: opts.remedyStatus,
    personalNote,
  };
}
