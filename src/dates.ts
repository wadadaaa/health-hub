/** Local calendar-day helpers. All "day" values are 'YYYY-MM-DD' strings in the configured timezone. */

let tz = process.env.TZ_LOCAL ?? 'Asia/Jerusalem';

export function setTimezone(zone: string) {
  tz = zone;
}

export function timezone() {
  return tz;
}

/** 'YYYY-MM-DD' of the given instant in the local timezone. */
export function localDay(instant: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function today(): string {
  return localDay(new Date());
}

/** Shift a 'YYYY-MM-DD' day by n days (calendar arithmetic, timezone-free). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Normalise a DATE column value coming back from the driver.
 * node-postgres returns a JS Date at *local* midnight; pg-mem does the same; some
 * setups return the 'YYYY-MM-DD' string. All collapse to 'YYYY-MM-DD'.
 */
export function dbDay(v: unknown): string {
  if (v instanceof Date) {
    const p = (x: number) => String(x).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

/** Normalise a TIMESTAMPTZ column value to an ISO-8601 UTC string. */
export function dbInstant(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export function isDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Inclusive list of days from start to end. */
export function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  let d = start;
  while (d <= end) {
    out.push(d);
    d = shiftDay(d, 1);
  }
  return out;
}

/** Parse Health Auto Export style dates: '2026-10-19 07:30:00 +0300' (also accepts ISO). */
export function parseLooseDate(s: string): Date | null {
  if (!s) return null;
  let iso = s.trim();
  const m = iso.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})$/);
  if (m) iso = `${m[1]}T${m[2]}${m[3]}:${m[4]}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
