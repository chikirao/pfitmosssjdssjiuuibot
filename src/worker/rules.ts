import { LIMITS, type Lesson, type LessonFilter, type UserSettings, type WatcherInput, type WatcherSchedule } from "../shared/types";
import { addDays, isoWeekday, mskHHMM, mskToUnix, mskToday, nowSec } from "./time";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function matchesFilter(l: Lesson, f: LessonFilter, today = mskToday()): boolean {
  if (l.date < today) return false;
  if (f.sections?.length && !f.sections.includes(l.section)) return false;
  if (f.buildings?.length && !f.buildings.includes(l.buildingId)) return false;
  if (f.days?.length && !f.days.includes(isoWeekday(l.date))) return false;
  if (f.timeFrom && l.start < f.timeFrom) return false;
  if (f.timeTo && l.start > f.timeTo) return false;
  if (f.teacher && !l.teacher.toLowerCase().includes(f.teacher.toLowerCase())) return false;
  if (f.onlyCanSign && !l.canSign) return false;
  if (f.noIntersect && l.intersection) return false;
  if (f.noFreeVisit && l.freeVisit) return false;
  if (f.query) {
    const q = f.query.toLowerCase();
    if (!`${l.section} ${l.teacher} ${l.room} ${l.comment}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

/** Место «открыто»: есть свободные места и сайт разрешает запись. */
export const isOpen = (l: Lesson) => l.available > 0 && l.canSign;

/** Занятие уже началось (или вот-вот) — записываться/предлагать поздно. */
export const lessonStartUnix = (l: { date: string; start: string }) => mskToUnix(l.date, l.start || "00:00");

/** Следующий запуск schedule-правила: ближайший подходящий день в time (МСК), строго после now. */
export function nextScheduleRun(s: WatcherSchedule, now = nowSec()): number {
  const today = mskToday(now * 1000);
  for (let i = 0; i <= 7; i++) {
    const day = addDays(today, i);
    if (s.days.length && !s.days.includes(isoWeekday(day))) continue;
    const at = mskToUnix(day, s.time);
    if (at > now) return at;
  }
  return now + 86400;
}

export function nextRunAt(w: Pick<WatcherInput, "mode" | "intervalMin" | "schedule" | "enabled">, now = nowSec(), immediate = false): number {
  if (!w.enabled) return 0;
  if (w.mode === "schedule" && w.schedule) return nextScheduleRun(w.schedule, now);
  return immediate ? now : now + Math.max(LIMITS.minIntervalMin, w.intervalMin ?? 15) * 60;
}

/** Тихие часы: interval-уведомления переносим (auto-запись всё равно делаем, но пишем молча). */
export function isQuiet(s: UserSettings, now = nowSec()): boolean {
  if (!s.quietFrom || !s.quietTo) return false;
  const t = mskHHMM(now * 1000);
  return s.quietFrom < s.quietTo ? t >= s.quietFrom && t < s.quietTo : t >= s.quietFrom || t < s.quietTo;
}

export class ValidationError extends Error {}

const uniqNums = (xs: unknown, min: number, max: number) =>
  Array.isArray(xs) ? [...new Set(xs.map(Number).filter((n) => Number.isInteger(n) && n >= min && n <= max))] : undefined;

export function sanitizeFilter(raw: unknown): LessonFilter {
  const f = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const time = (v: unknown) => (typeof v === "string" && HHMM.test(v) ? v : undefined);
  const out: LessonFilter = {
    sections: Array.isArray(f.sections) ? [...new Set(f.sections.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, 120)))].slice(0, 30) : undefined,
    query: str(f.query),
    buildings: uniqNums(f.buildings, 1, 1e9),
    days: uniqNums(f.days, 1, 7),
    timeFrom: time(f.timeFrom),
    timeTo: time(f.timeTo),
    teacher: str(f.teacher, 60),
    onlyCanSign: f.onlyCanSign === true || undefined,
    noIntersect: f.noIntersect === true || undefined,
    noFreeVisit: f.noFreeVisit === true || undefined,
    weeks: Math.min(LIMITS.maxWeeks, Math.max(1, Number(f.weeks) || 2)),
  };
  for (const k of Object.keys(out) as (keyof LessonFilter)[]) {
    const v = out[k];
    if (v === undefined || (Array.isArray(v) && !v.length)) delete out[k];
  }
  return out;
}

export function sanitizeWatcher(raw: unknown): WatcherInput {
  const w = (raw ?? {}) as Record<string, unknown>;
  const mode = w.mode === "schedule" ? "schedule" : "interval";
  const action = w.action === "offer" || w.action === "auto" ? w.action : "notify";
  const filter = sanitizeFilter(w.filter);
  const name = typeof w.name === "string" && w.name.trim() ? w.name.trim().slice(0, 60) : filter.sections?.join(", ").slice(0, 60) || "Все секции";

  let intervalMin: number | null = null;
  let schedule: WatcherSchedule | null = null;
  if (mode === "interval") {
    const n = Number(w.intervalMin);
    intervalMin = (LIMITS.intervalChoices as readonly number[]).includes(n) ? n : 15;
  } else {
    const s = (w.schedule ?? {}) as Record<string, unknown>;
    if (typeof s.time !== "string" || !HHMM.test(s.time)) throw new ValidationError("Укажи время в формате ЧЧ:ММ");
    schedule = { time: s.time, days: uniqNums(s.days, 1, 7)?.sort() ?? [] };
  }
  if (action === "auto" && mode === "schedule") throw new ValidationError("Автозапись работает только с проверкой по интервалу");
  return { name, enabled: w.enabled !== false, filter, mode, intervalMin, schedule, action };
}

export function sanitizeSettings(raw: unknown, current: UserSettings): UserSettings {
  const s = (raw ?? {}) as Record<string, unknown>;
  const time = (v: unknown, fallback: string | null) => (v === null ? null : typeof v === "string" && HHMM.test(v) ? v : fallback);
  return {
    autoUseLastAttempt: typeof s.autoUseLastAttempt === "boolean" ? s.autoUseLastAttempt : current.autoUseLastAttempt,
    autoAllowIntersection: typeof s.autoAllowIntersection === "boolean" ? s.autoAllowIntersection : current.autoAllowIntersection,
    quietFrom: s.quietFrom === undefined ? current.quietFrom : time(s.quietFrom, current.quietFrom),
    quietTo: s.quietTo === undefined ? current.quietTo : time(s.quietTo, current.quietTo),
  };
}

/** Человекочитаемое описание правила — для чата и списков. */
export function describeWatcher(w: WatcherInput): string {
  const days = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  const when =
    w.mode === "interval"
      ? `каждые ${w.intervalMin} мин`
      : `${w.schedule!.days.length && w.schedule!.days.length < 7 ? w.schedule!.days.map((d) => days[d]).join(", ") : "каждый день"} в ${w.schedule!.time}`;
  const act = { notify: "уведомлять", offer: "предлагать запись", auto: "записывать сам" }[w.action];
  const f = w.filter;
  const parts = [
    f.sections?.length ? f.sections.join(", ") : "все секции",
    f.days?.length ? f.days.map((d) => days[d]).join(", ") : "",
    f.timeFrom || f.timeTo ? `${f.timeFrom ?? "…"}–${f.timeTo ?? "…"}` : "",
  ].filter(Boolean);
  return `${parts.join(" · ")} — ${when}, ${act}`;
}

export { nowSec };
