import { invalid } from './money.js';

export function calendarDate(value: unknown, field = 'date'): string {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d\d-\d\d$/.test(value) ||
      value.startsWith('0000')) return invalid(field);
  const ms = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== value) return invalid(field);
  return value;
}
export function clockTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length !== 5 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return invalid(field);
  return value;
}
export function localMinute(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 16 || value[10] !== 'T') return invalid('occurredLocal');
  calendarDate(value.slice(0,10),'occurredLocal');
  clockTime(value.slice(11),'occurredLocal');
  return value;
}
export function tripClock(instant: string, timeZone: string): {date: string; time: string} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date(instant));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === name)!.value;
  return {date:part('year').padStart(4,'0')+'-'+part('month')+'-'+part('day'),time:part('hour')+':'+part('minute')};
}
export function occurredAt(local: string, zone: string): string {
  const wall = Date.parse(localMinute(local) + ':00Z');
  if (typeof zone !== 'string' || !zone || /^[+-]/.test(zone)) return invalid('timeZone');
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'longOffset' });
  } catch { return invalid('timeZone'); }

  // Probe offsets on both sides of the civil day. Verify each candidate's actual offset
  // to exclude a gap, then pick the earliest valid instant of an overlap.
  function offset(ms: number): number {
    const label = formatter.formatToParts(ms).find(p => p.type === 'timeZoneName')!.value;
    if (label === 'GMT') return 0;
    const m = /^GMT([+-])(\d\d):(\d\d)(?::(\d\d))?$/.exec(label);
    if (!m) return invalid('timeZone');
    return (Number(m[2])*3600 + Number(m[3])*60 + Number(m[4] ?? 0)) * (m[1] === '-' ? -1000 : 1000);
  }
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) offsets.add(offset(wall + hours * 3600000));
  const matches = [...offsets].map(o => wall-o).filter(ms => ms + offset(ms) === wall);
  if (!matches.length) return invalid('occurredLocal');
  return new Date(Math.min(...matches)).toISOString();
}
