// 일정이 잡힌 할 일을 .ics(iCalendar) 파일로 내보낸다
import type { Household } from '../domain/types.js';

function stamp(local: string): string {
  // Floating local time: no "Z", so calendars show it at the household's own clock time.
  return `${local.replace(/[-:]/g, '').slice(0, 13)}00`;
}

function escapeText(s: string): string {
  return s.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
}

export function calendarIcs(h: Household): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Home Ahead//Safety tasks//EN', 'CALSCALE:GREGORIAN'];
  for (const t of h.tasks.filter((x) => x.dueAt && x.status === 'open')) {
    const start = stamp(t.dueAt!);
    const endDate = new Date(`${t.dueAt}:00Z`);
    endDate.setUTCMinutes(endDate.getUTCMinutes() + 30);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${t.id}@home-ahead.local`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART:${start}`,
      `DTEND:${stamp(endDate.toISOString().slice(0, 16))}`,
      `SUMMARY:${escapeText(t.title)}`,
      ...(t.room ? [`LOCATION:${escapeText(t.room)}`] : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
