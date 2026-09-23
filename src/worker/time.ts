// Всё расписание ИТМО — в Москве (UTC+3, без перехода на летнее время). Воркер живёт в UTC.
export const MSK_OFFSET_MS = 3 * 3600 * 1000;

export const nowSec = () => Math.floor(Date.now() / 1000);

/** «Настенное» время Москвы в виде Date, у которого UTC-поля = московские. */
export function mskWall(ms = Date.now()): Date {
  return new Date(ms + MSK_OFFSET_MS);
}

const pad = (n: number) => String(n).padStart(2, "0");

export function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function mskToday(ms = Date.now()): string {
  return ymd(mskWall(ms));
}

export function mskHHMM(ms = Date.now()): string {
  const d = mskWall(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** ISO-день недели по МСК: 1 = пн … 7 = вс. */
export function isoWeekday(dateYmd: string): number {
  const d = new Date(dateYmd + "T12:00:00Z").getUTCDay();
  return d === 0 ? 7 : d;
}

/** Понедельник текущей московской недели, YYYY-MM-DD. */
export function mskMonday(ms = Date.now()): string {
  const today = mskToday(ms);
  return addDays(today, 1 - isoWeekday(today));
}

export function addDays(dateYmd: string, days: number): string {
  const d = new Date(dateYmd + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return ymd(d);
}

/** Unix-секунды для московских даты и времени. */
export function mskToUnix(dateYmd: string, hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const utc = Date.UTC(+dateYmd.slice(0, 4), +dateYmd.slice(5, 7) - 1, +dateYmd.slice(8, 10), h, m);
  return Math.floor((utc - MSK_OFFSET_MS) / 1000);
}

/** Попадает ли московское HH:MM в интервал [from, to), учитывая переход через полночь. */
export function inWindow(hhmm: string, from: string | null, to: string | null): boolean {
  if (!from || !to || from === to) return false;
  return from < to ? hhmm >= from && hhmm < to : hhmm >= from || hhmm < to;
}

