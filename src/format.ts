const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const timeFmt = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('it-IT', { weekday: 'long' });
const shortFmt = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
const monthFmt = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' });
const longFmt = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

/** Section header in the note list, like Apple Notes. */
export function groupLabel(ms: number, now = new Date()): string {
  const diff = (startOfDay(now) - startOfDay(new Date(ms))) / DAY;
  if (diff <= 0) return 'Oggi';
  if (diff === 1) return 'Ieri';
  if (diff <= 7) return '7 giorni precedenti';
  if (diff <= 30) return '30 giorni precedenti';
  const label = monthFmt.format(ms);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Compact date next to the preview in the note list. */
export function listDate(ms: number, now = new Date()): string {
  const diff = (startOfDay(now) - startOfDay(new Date(ms))) / DAY;
  if (diff <= 0) return timeFmt.format(ms);
  if (diff === 1) return 'Ieri';
  if (diff < 7) return weekdayFmt.format(ms);
  return shortFmt.format(ms);
}

/** "3 ottobre 2026 alle 14:52" above the note body. */
export function longDate(ms: number): string {
  return `${longFmt.format(ms)} alle ${timeFmt.format(ms)}`;
}

export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 160);
  }
  return '';
}
