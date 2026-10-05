// 음성 응답 문장 도우미: Alexa+ 응답 규칙(30초 미만, URL·ID·JSON 금지)을 지키는 문장을 만든다

/** About 150 words a minute; 70 words stays well under 30 seconds. */
export const MAX_SPOKEN_WORDS = 70;

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Problems that would make a reply unfit to be read aloud. Empty means it is fine. */
export function speechProblems(s: string): string[] {
  const problems: string[] = [];
  if (wordCount(s) > MAX_SPOKEN_WORDS) problems.push(`too long (${wordCount(s)} words)`);
  if (/https?:\/\/|www\.|\.(com|gov|org)\b/i.test(s)) problems.push('contains a URL');
  if (/[{}[\]]|"\w+":/.test(s)) problems.push('looks like JSON');
  if (/\b(it|tk|ord|rm|ch|al)_[a-z0-9]+\b/i.test(s)) problems.push('contains an internal id');
  if (/\b[a-z]+_[a-z_]+\b/.test(s)) problems.push('contains a tool or field name');
  if (/@/.test(s)) problems.push('contains an email address');
  return problems;
}

export function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export function countPhrase(n: number, singular: string, plural = `${singular}s`): string {
  return `${NUMBER_WORDS[n] ?? n} ${n === 1 ? singular : plural}`;
}

export function monthYear(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "a"/"an" for a following word. */
export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}
