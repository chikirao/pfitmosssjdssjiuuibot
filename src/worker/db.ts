import { DEFAULT_SETTINGS, type Catch, type Lesson, type LessonFilter, type UserSettings, type Watcher, type WatcherInput } from "../shared/types";
import { nowSec } from "./time";

export interface UserRow {
  tg_id: number;
  first_name: string | null;
  username: string | null;
  access_enc: string | null;
  access_exp: number | null;
  refresh_enc: string | null;
  refresh_exp: number | null;
  token_status: "none" | "ok" | "expired";
  token_alerted: number;
  refresh_lock_until: number;
  settings: string;
  paused_until: number;
  created_at: number;
  updated_at: number;
}

export function parseSettings(raw: string | null | undefined): UserSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw || "{}") as Partial<UserSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ---------- users ----------

export function getUser(db: D1Database, id: number) {
  return db.prepare("SELECT * FROM users WHERE tg_id = ?").bind(id).first<UserRow>();
}

export async function upsertUser(db: D1Database, u: { id: number; first_name?: string; username?: string }) {
  const now = nowSec();
  await db
    .prepare(
      `INSERT INTO users (tg_id, first_name, username, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT(tg_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username, updated_at = excluded.updated_at`,
    )
    .bind(u.id, u.first_name ?? null, u.username ?? null, now)
    .run();
}

export async function saveSettings(db: D1Database, id: number, s: UserSettings) {
  await db.prepare("UPDATE users SET settings = ?, updated_at = ? WHERE tg_id = ?").bind(JSON.stringify(s), nowSec(), id).run();
}

export async function setPaused(db: D1Database, id: number, until: number) {
  await db.prepare("UPDATE users SET paused_until = ?, updated_at = ? WHERE tg_id = ?").bind(until, nowSec(), id).run();
}

/** Удаляет пользователя и всё связанное (каскадом). */
export async function deleteUser(db: D1Database, id: number) {
  await db.batch([
    db.prepare("DELETE FROM seen WHERE watcher_id IN (SELECT id FROM watchers WHERE tg_id = ?)").bind(id),
    db.prepare("DELETE FROM watchers WHERE tg_id = ?").bind(id),
    db.prepare("DELETE FROM catches WHERE tg_id = ?").bind(id),
    db.prepare("DELETE FROM offers WHERE tg_id = ?").bind(id),
    db.prepare("DELETE FROM signups WHERE tg_id = ?").bind(id),
    db.prepare("DELETE FROM users WHERE tg_id = ?").bind(id),
  ]);
}

export async function usersWithTokens(db: D1Database) {
  return (await db.prepare("SELECT * FROM users WHERE token_status = 'ok' AND refresh_enc IS NOT NULL").all<UserRow>()).results;
}

// ---------- watchers ----------

interface WatcherRow {
  id: number;
  tg_id: number;
  name: string;
  enabled: number;
  filter: string;
  mode: "interval" | "schedule";
  interval_min: number | null;
  schedule: string | null;
  action: "notify" | "offer" | "auto";
  next_run_at: number;
  last_run_at: number | null;
  primed: number;
}

export type WatcherWithOwner = Watcher & { tgId: number; primed: boolean };

function toWatcher(r: WatcherRow): WatcherWithOwner {
  return {
    id: r.id,
    tgId: r.tg_id,
    name: r.name,
    enabled: !!r.enabled,
    filter: JSON.parse(r.filter) as LessonFilter,
    mode: r.mode,
    intervalMin: r.interval_min,
    schedule: r.schedule ? JSON.parse(r.schedule) : null,
    action: r.action,
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    primed: !!r.primed,
  };
}

export async function listWatchers(db: D1Database, tgId: number) {
  const rows = (await db.prepare("SELECT * FROM watchers WHERE tg_id = ? ORDER BY id").bind(tgId).all<WatcherRow>()).results;
  return rows.map(toWatcher);
}

export async function getWatcher(db: D1Database, tgId: number, id: number) {
  const r = await db.prepare("SELECT * FROM watchers WHERE tg_id = ? AND id = ?").bind(tgId, id).first<WatcherRow>();
  return r ? toWatcher(r) : null;
}

export async function dueWatchers(db: D1Database, now: number) {
  const rows = (
    await db
      .prepare(
        `SELECT w.* FROM watchers w JOIN users u ON u.tg_id = w.tg_id
         WHERE w.enabled = 1 AND w.next_run_at <= ? AND u.token_status = 'ok' ORDER BY w.next_run_at LIMIT 50`,
      )
      .bind(now)
      .all<WatcherRow>()
  ).results;
  return rows.map(toWatcher);
}

export async function insertWatcher(db: D1Database, tgId: number, w: WatcherInput, nextRunAt: number) {
  const r = await db
    .prepare(
      `INSERT INTO watchers (tg_id, name, enabled, filter, mode, interval_min, schedule, action, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(tgId, w.name, w.enabled ? 1 : 0, JSON.stringify(w.filter), w.mode, w.intervalMin, w.schedule ? JSON.stringify(w.schedule) : null, w.action, nextRunAt, nowSec())
    .first<{ id: number }>();
  return r!.id;
}

export async function updateWatcher(db: D1Database, tgId: number, id: number, w: WatcherInput, nextRunAt: number) {
  // фильтр мог поменяться — старое состояние «видел/не видел» больше не имеет смысла
  await db.batch([
    db
      .prepare(
        `UPDATE watchers SET name = ?, enabled = ?, filter = ?, mode = ?, interval_min = ?, schedule = ?, action = ?, next_run_at = ?, primed = 0
         WHERE tg_id = ? AND id = ?`,
      )
      .bind(w.name, w.enabled ? 1 : 0, JSON.stringify(w.filter), w.mode, w.intervalMin, w.schedule ? JSON.stringify(w.schedule) : null, w.action, nextRunAt, tgId, id),
    db.prepare("DELETE FROM seen WHERE watcher_id = ?").bind(id),
  ]);
}

export async function setWatcherEnabled(db: D1Database, tgId: number, id: number, enabled: boolean, nextRunAt: number) {
  await db.prepare("UPDATE watchers SET enabled = ?, next_run_at = ? WHERE tg_id = ? AND id = ?").bind(enabled ? 1 : 0, nextRunAt, tgId, id).run();
}

export async function deleteWatcher(db: D1Database, tgId: number, id: number) {
  await db.batch([
    db.prepare("DELETE FROM seen WHERE watcher_id = (SELECT id FROM watchers WHERE tg_id = ? AND id = ?)").bind(tgId, id),
    db.prepare("DELETE FROM watchers WHERE tg_id = ? AND id = ?").bind(tgId, id),
  ]);
}

export async function markWatcherRun(db: D1Database, id: number, now: number, nextRunAt: number) {
  await db.prepare("UPDATE watchers SET last_run_at = ?, next_run_at = ?, primed = 1 WHERE id = ?").bind(now, nextRunAt, id).run();
}

export async function getSeen(db: D1Database, watcherId: number) {
  const rows = (await db.prepare("SELECT lesson_key, open FROM seen WHERE watcher_id = ?").bind(watcherId).all<{ lesson_key: string; open: number }>()).results;
  return new Map(rows.map((r) => [r.lesson_key, !!r.open]));
}

export async function replaceSeen(db: D1Database, watcherId: number, state: Map<string, boolean>) {
  const now = nowSec();
  const stmts = [db.prepare("DELETE FROM seen WHERE watcher_id = ?").bind(watcherId)];
  for (const [k, open] of state) {
    stmts.push(db.prepare("INSERT INTO seen (watcher_id, lesson_key, open, updated_at) VALUES (?, ?, ?, ?)").bind(watcherId, k, open ? 1 : 0, now));
  }
  await db.batch(stmts);
}

// ---------- catches ----------

interface CatchRow {
  id: number;
  tg_id: number;
  lesson_id: number;
  lesson_group: number | null;
  building_id: number;
  date: string;
  start: string;
  finish: string | null;
  section: string;
  status: Catch["status"];
  result: string | null;
  expires_at: number;
  last_check_at: number | null;
  created_at: number;
}

export type CatchWithOwner = Catch & { tgId: number; groupId: number | null };

const toCatch = (r: CatchRow): CatchWithOwner => ({
  id: r.id,
  tgId: r.tg_id,
  groupId: r.lesson_group,
  lessonId: r.lesson_id,
  date: r.date,
  start: r.start,
  end: r.finish,
  section: r.section,
  buildingId: r.building_id,
  status: r.status,
  result: r.result,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

export async function listCatches(db: D1Database, tgId: number, includeFinished = true) {
  const rows = (
    await db
      .prepare(`SELECT * FROM catches WHERE tg_id = ? ${includeFinished ? "" : "AND status = 'active'"} ORDER BY status = 'active' DESC, created_at DESC LIMIT 30`)
      .bind(tgId)
      .all<CatchRow>()
  ).results;
  return rows.map(toCatch);
}

export async function activeCatches(db: D1Database) {
  const rows = (
    await db
      .prepare(`SELECT c.* FROM catches c JOIN users u ON u.tg_id = c.tg_id WHERE c.status = 'active' AND u.token_status = 'ok' ORDER BY c.last_check_at IS NOT NULL, c.last_check_at`)
      .all<CatchRow>()
  ).results;
  return rows.map(toCatch);
}

export async function countActiveCatches(db: D1Database, tgId: number) {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM catches WHERE tg_id = ? AND status = 'active'").bind(tgId).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function insertCatch(db: D1Database, tgId: number, l: Lesson, expiresAt: number) {
  const dup = await db.prepare("SELECT id FROM catches WHERE tg_id = ? AND lesson_id = ? AND date = ? AND status = 'active'").bind(tgId, l.id, l.date).first<{ id: number }>();
  if (dup) return dup.id;
  const r = await db
    .prepare(
      `INSERT INTO catches (tg_id, lesson_id, lesson_group, building_id, date, start, finish, section, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(tgId, l.id, l.groupId, l.buildingId, l.date, l.start, l.end, l.section, expiresAt, nowSec())
    .first<{ id: number }>();
  return r!.id;
}

export async function finishCatch(db: D1Database, id: number, status: Catch["status"], result: string | null) {
  await db.prepare("UPDATE catches SET status = ?, result = ?, last_check_at = ? WHERE id = ?").bind(status, result, nowSec(), id).run();
}

export async function touchCatch(db: D1Database, id: number) {
  await db.prepare("UPDATE catches SET last_check_at = ? WHERE id = ?").bind(nowSec(), id).run();
}

export async function cancelCatch(db: D1Database, tgId: number, id: number) {
  await db.prepare("UPDATE catches SET status = 'cancelled', result = 'Отменено' WHERE tg_id = ? AND id = ? AND status = 'active'").bind(tgId, id).run();
}

// ---------- offers ----------

export async function insertOffer(db: D1Database, tgId: number, watcherId: number | null, l: Lesson, expiresAt: number) {
  const r = await db
    .prepare("INSERT INTO offers (tg_id, watcher_id, lesson, expires_at, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(tgId, watcherId, JSON.stringify(l), expiresAt, nowSec())
    .first<{ id: number }>();
  return r!.id;
}

export async function takeOffer(db: D1Database, tgId: number, id: number, status: "accepted" | "declined") {
  // атомарно: только pending и не истёкшее, чтобы двойное нажатие не записало дважды
  const r = await db
    .prepare("UPDATE offers SET status = ? WHERE tg_id = ? AND id = ? AND status = 'pending' AND expires_at > ? RETURNING lesson, watcher_id")
    .bind(status, tgId, id, nowSec())
    .first<{ lesson: string; watcher_id: number | null }>();
  return r ? { lesson: JSON.parse(r.lesson) as Lesson, watcherId: r.watcher_id } : null;
}

export async function setOfferStatus(db: D1Database, id: number, status: string) {
  await db.prepare("UPDATE offers SET status = ? WHERE id = ?").bind(status, id).run();
}

// ---------- signups log ----------

export async function logSignup(
  db: D1Database,
  tgId: number,
  l: { id: number; section?: string | null; date?: string | null; start?: string | null },
  source: string,
  action: "sign" | "unsign",
  ok: boolean,
  message: string | null,
) {
  await db
    .prepare("INSERT INTO signups (tg_id, lesson_id, section, date, start, source, action, ok, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(tgId, l.id, l.section ?? null, l.date ?? null, l.start ?? null, source, action, ok ? 1 : 0, message, nowSec())
    .run();
}

export async function countAutoSignupsSince(db: D1Database, tgId: number, since: number) {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM signups WHERE tg_id = ? AND ok = 1 AND action = 'sign' AND source IN ('auto', 'catch') AND created_at >= ?")
    .bind(tgId, since)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function recentSignups(db: D1Database, tgId: number, limit = 20) {
  return (
    await db
      .prepare("SELECT lesson_id, section, date, start, source, action, ok, message, created_at FROM signups WHERE tg_id = ? ORDER BY created_at DESC LIMIT ?")
      .bind(tgId, limit)
      .all<{ lesson_id: number; section: string | null; date: string | null; start: string | null; source: string; action: string; ok: number; message: string | null; created_at: number }>()
  ).results;
}

/** Уборка: старые офферы/ловли/журнал, протухший кэш. */
export async function cleanup(db: D1Database, now: number) {
  await db.batch([
    db.prepare("UPDATE offers SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").bind(now),
    db.prepare("DELETE FROM offers WHERE created_at < ?").bind(now - 30 * 86400),
    db.prepare("UPDATE catches SET status = 'expired', result = 'Занятие уже началось' WHERE status = 'active' AND expires_at <= ?").bind(now),
    db.prepare("DELETE FROM catches WHERE status != 'active' AND created_at < ?").bind(now - 30 * 86400),
    db.prepare("DELETE FROM signups WHERE created_at < ?").bind(now - 120 * 86400),
    db.prepare("DELETE FROM cache WHERE expires_at < ?").bind(now),
  ]);
}
