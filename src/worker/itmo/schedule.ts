// Расписание физры: эндпоинты найдены в JS-бандле my.itmo.ru (страница /sport/sign).
import type { ChosenLesson, Lesson, Option, Score } from "../../shared/types";
import { addDays, isoWeekday, mskMonday, mskToday } from "../time";
import { TokenExpiredError, type ItmoClient } from "./client";

interface RawOption {
  id: number;
  value: string;
}
interface RawFilters {
  building_id?: RawOption[];
  sport_type_id?: RawOption[];
  teacher_isu?: RawOption[];
}
interface RawSlot {
  id: number;
  time_start: string;
  time_end: string;
}
interface RawLesson {
  id: number;
  section_name?: string;
  sport_type_id?: number;
  lesson_level?: number;
  type_id?: number;
  lesson_group_id?: number;
  time_slot_id?: number;
  time_start?: string;
  time_end?: string;
  date?: string;
  date_end?: string;
  room_name?: string;
  teacher_fio?: string;
  comment?: string;
  can_sign_in?: { can_sign_in?: boolean } | boolean;
  intersection?: boolean;
  other_lessons?: { id: number }[];
}
interface RawDay {
  date: string;
  lessons?: RawLesson[];
}
type RawLimits = Record<string, Record<string, { available?: number; limit?: number }>>;

export const DEFAULT_BUILDING = 273;
const DICT_TTL_SEC = 12 * 3600;

async function cached<T>(db: D1Database, key: string, load: () => Promise<T>): Promise<T> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare("SELECT value FROM cache WHERE key = ? AND expires_at > ?").bind(key, now).first<{ value: string }>();
  if (row) return JSON.parse(row.value) as T;
  const value = await load();
  await db
    .prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at")
    .bind(key, JSON.stringify(value), now + DICT_TTL_SEC)
    .run();
  return value;
}

export interface Dictionaries {
  buildings: Option[];
  sportTypes: Option[];
  slots: RawSlot[];
}

export async function getDictionaries(client: ItmoClient, db: D1Database): Promise<Dictionaries> {
  const filters = await cached(db, "filters", () => client.get<RawFilters>("/api/sport/sign/schedule/filters"));
  const slots = await cached(db, "time_slots", () => client.get<RawSlot[]>("/api/sport/time_slots").catch(() => [] as RawSlot[]));
  const opt = (xs?: RawOption[]) => (xs ?? []).map((x) => ({ id: Number(x.id), name: String(x.value) }));
  const buildings = opt(filters?.building_id);
  return {
    buildings: buildings.length ? buildings : [{ id: DEFAULT_BUILDING, name: "Кронверкский пр., 49" }],
    sportTypes: opt(filters?.sport_type_id),
    slots: slots ?? [],
  };
}

export function getLimits(client: ItmoClient) {
  return client.get<RawLimits>("/api/sport/sign/schedule/limits");
}

const hhmm = (v?: string | null) => {
  if (!v) return "";
  const s = v.includes("T") ? v.split("T")[1]! : v;
  return s.slice(0, 5);
};

/** Время из ISO-даты занятия (`date`/`date_end`). Это настоящее время: сайт показывает его в карточке,
 *  а сетка расписания рисуется по слотам (вечером слоты по 2 ч, и 19:10–20:10 выглядит как 19:00–21:00). */
const isoTime = (v?: string | null) => {
  const t = v && v.includes("T") ? hhmm(v) : "";
  return t && t !== "00:00" ? t : "";
};

export const lessonKey = (l: { id: number; date: string; start: string; groupId: number | null }) => `${l.date}|${l.id}|${l.start}|${l.groupId ?? ""}`;

/** Свободные места: limits[group][lesson]; у «свободного посещения» — лучший из other_lessons. */
export function seatsFor(limits: RawLimits, l: { id: number; lesson_group_id?: number; other_lessons?: { id: number }[] }) {
  const group = limits[String(l.lesson_group_id)] ?? {};
  let own = group[String(l.id)];
  if (!own) {
    for (const o of l.other_lessons ?? []) {
      const x = group[String(o.id)];
      if (x && (!own || (x.available ?? 0) > (own.available ?? 0))) own = x;
    }
  }
  return { available: Math.max(0, own?.available ?? 0), limit: Math.max(0, own?.limit ?? 0) };
}

export function normalizeDays(days: RawDay[], buildingId: number, buildingName: string, limits: RawLimits, slots: RawSlot[]): Lesson[] {
  const bySlot = new Map(slots.map((s) => [s.id, s]));
  const out: Lesson[] = [];
  for (const day of days ?? []) {
    for (const l of day.lessons ?? []) {
      const slot = l.time_slot_id != null ? bySlot.get(l.time_slot_id) : undefined;
      const can = l.can_sign_in;
      const slotStart = hhmm(l.time_start || slot?.time_start || l.date);
      const base = {
        id: Number(l.id),
        groupId: l.lesson_group_id ?? null,
        date: String(l.date || day.date || "").slice(0, 10),
      };
      out.push({
        ...base,
        start: isoTime(l.date) || slotStart,
        // ключ — по слоту, как раньше: не сбивает состояние правил и ловушек
        key: lessonKey({ ...base, start: slotStart }),
        buildingId,
        buildingName,
        end: isoTime(l.date_end) || hhmm(l.time_end || slot?.time_end || l.date_end),
        section: (l.section_name || "Без названия").trim(),
        sportTypeId: l.sport_type_id ?? null,
        freeVisit: l.lesson_level === 1,
        typeId: l.type_id ?? null,
        teacher: l.teacher_fio || "",
        room: l.room_name || "",
        comment: l.comment || "",
        ...seatsFor(limits, l),
        canSign: typeof can === "object" && can ? !!can.can_sign_in : !!can,
        intersection: !!l.intersection,
      });
    }
  }
  return out;
}

export interface ScheduleQuery {
  buildings: number[];
  from: string; // YYYY-MM-DD включительно
  to: string; // YYYY-MM-DD включительно
}

const mondayOf = (d: string) => addDays(d, 1 - isoWeekday(d));

/** Недели (пн), которые задевает диапазон: у ИТМО спрашиваем ровно такими кусками, как делает сайт. */
export function weekStarts(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ds = mondayOf(from); ds <= to; ds = addDays(ds, 7)) out.push(ds);
  return out;
}

/** «N недель вперёд» для правил: с сегодня до конца N-й недели. */
export const rangeForWeeks = (weeks: number, ms = Date.now()) => ({ from: mskToday(ms), to: addDays(mskMonday(ms), 7 * weeks - 1) });

export async function fetchSchedule(client: ItmoClient, db: D1Database, q: ScheduleQuery) {
  const dict = await getDictionaries(client, db);
  const names = new Map(dict.buildings.map((b) => [b.id, b.name]));
  const buildings = q.buildings.length ? q.buildings : dict.buildings.map((b) => b.id);
  const limits = await getLimits(client);

  const jobs: Promise<Lesson[]>[] = [];
  for (const b of buildings) {
    for (const ds of weekStarts(q.from, q.to)) {
      const qs = new URLSearchParams({ building_id: String(b), date_start: ds, date_end: addDays(ds, 7) });
      jobs.push(client.get<RawDay[]>(`/api/sport/sign/schedule?${qs}`).then((days) => normalizeDays(days ?? [], b, names.get(b) ?? `Корпус ${b}`, limits, dict.slots)));
    }
  }
  const seen = new Set<string>();
  const lessons = (await Promise.all(jobs))
    .flat()
    .filter((l) => l.date >= q.from && l.date <= q.to)
    .filter((l) => (seen.has(l.buildingId + l.key) ? false : (seen.add(l.buildingId + l.key), true)))
    .sort((a, b) => (a.date + a.start + a.section).localeCompare(b.date + b.start + b.section));
  return { dict, lessons };
}

/** Сколько внешних запросов съест fetchSchedule (без кэша справочников). */
export const scheduleCost = (buildings: number, weeks: number) => 1 + buildings * weeks;

// ---- записи пользователя ----

interface RawChosenLesson {
  id: number;
  section_name?: string;
  date?: string;
  date_start?: string;
  date_end?: string;
  time_start?: string;
  time_end?: string;
  room_name?: string;
  teacher_fio?: string;
  lesson_group_id?: number;
}

/** /sign/chosen возвращает секции → группы → занятия; структуру разбираем осторожно. */
export function flattenChosen(raw: unknown): ChosenLesson[] {
  const out: ChosenLesson[] = [];
  const visit = (node: unknown, section: string | null, groupId: number | null) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, section, groupId));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const name = (typeof o.section_name === "string" && o.section_name) || (typeof o.name === "string" && o.name) || section;
    const gid = typeof o.lesson_group_id === "number" ? o.lesson_group_id : groupId;
    if (Array.isArray(o.lesson_groups)) return visit(o.lesson_groups, name, gid);
    if (Array.isArray(o.lessons)) return visit(o.lessons, name, typeof o.id === "number" && !o.date && !o.date_start ? o.id : gid);
    if (typeof o.id === "number" && (o.date_start || o.date)) {
      const l = o as unknown as RawChosenLesson;
      const startIso = l.date_start || l.date || "";
      out.push({
        id: l.id,
        section: name || "Занятие",
        date: startIso.slice(0, 10),
        start: isoTime(startIso) || hhmm(l.time_start || startIso),
        end: isoTime(l.date_end) || hhmm(l.time_end || l.date_end),
        room: l.room_name || "",
        teacher: l.teacher_fio || "",
        groupId: gid,
      });
    }
  };
  visit(raw, null, null);
  const seen = new Set<number>();
  return out.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true))).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

export async function getChosen(client: ItmoClient) {
  return flattenChosen(await client.get<unknown>("/api/sport/sign/chosen"));
}

export async function getAttempts(client: ItmoClient): Promise<{ free: number | null; total: number | null }> {
  try {
    const r = await client.get<{ free_attempts?: number; total_attempts?: number }>("/api/sport/personal/have_attempts");
    return { free: r?.free_attempts ?? null, total: r?.total_attempts ?? null };
  } catch {
    return { free: null, total: null };
  }
}

/** Баллы за семестр: /semesters/current → /personal/score (result.sum = {attendances, other}). */
export async function getScore(client: ItmoClient): Promise<Score> {
  try {
    const sem = await client.get<{ id?: number; name?: string; title?: string; value?: string }>("/api/sport/semesters/current");
    if (sem?.id == null) return { attendance: null, other: null, semester: null };
    const r = await client.get<{ sum?: Record<string, number> | null }>(`/api/sport/personal/score?semester_id=${sem.id}`);
    const sum = r?.sum ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      attendance: num(sum.attendances),
      // всё, что не посещения, — «дополнительные» (на сайте это ключ other)
      other: Object.entries(sum).reduce((a, [k, v]) => (k === "attendances" ? a : a + num(v)), 0),
      semester: sem.name ?? sem.title ?? sem.value ?? null,
    };
  } catch (e) {
    if (e instanceof TokenExpiredError) throw e;
    return { attendance: null, other: null, semester: null };
  }
}

/** Запись на конкретные занятия (режим «A» на сайте — одно занятие). */
export function signLessons(client: ItmoClient, ids: number[]) {
  return client.post<unknown>("/api/sport/sign/schedule/lessons", ids);
}

export function unsignLessons(client: ItmoClient, ids: number[]) {
  return client.del<unknown>("/api/sport/sign/schedule/lessons", ids);
}
