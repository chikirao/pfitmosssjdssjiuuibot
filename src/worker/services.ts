// Общая логика для API мини-аппа и бота.
import { LIMITS, type Lesson, type LessonFilter, type ScheduleResponse, type TokenStatus, type WatcherInput } from "../shared/types";
import { countActiveCatches, getUser, insertCatch, insertWatcher, listWatchers, updateWatcher, type UserRow } from "./db";
import type { Env } from "./env";
import type { ItmoClient } from "./itmo/client";
import { fetchSchedule, rangeForWeeks } from "./itmo/schedule";
import { replaceTokens } from "./itmo/session";
import { parseTokenInput, TokenInputError } from "./itmo/tokens";
import { lessonStartUnix, matchesFilter, nextRunAt, ValidationError } from "./rules";
import { nowSec } from "./time";

export function tokenStatus(row: UserRow | null): TokenStatus {
  if (!row) return { status: "none", accessExp: null, refreshExp: null };
  return { status: row.token_status, accessExp: row.access_exp, refreshExp: row.refresh_enc ? (row.refresh_exp ?? 0) : null };
}

export async function acceptTokenInput(env: Env, tgId: number, text: string) {
  const pair = parseTokenInput(text, nowSec());
  await replaceTokens(env, tgId, pair);
  return {
    hasRefresh: !!pair.refresh,
    refreshExp: pair.refreshExp,
    message: pair.refresh
      ? "Токен сохранён. Бот сам будет его продлевать, пока жива сессия ИТМО."
      : "Сохранил только access-токен — refresh-токена в присланном нет, поэтому через ~30 минут доступ пропадёт. Запусти свежий скрипт из /token: если он напишет, что refresh не найден, выйди из my.itmo.ru, войди заново и повтори.",
  };
}

export { TokenInputError, ValidationError };

export async function loadSchedule(env: Env, client: ItmoClient, q: { buildings?: number[]; from: string; to: string }): Promise<ScheduleResponse> {
  const { dict, lessons } = await fetchSchedule(client, env.DB, { buildings: q.buildings ?? [], from: q.from, to: q.to });
  return { fetchedAt: new Date().toISOString(), dateStart: q.from, dateEnd: q.to, buildings: dict.buildings, lessons };
}

/** Открытые занятия по фильтру (для /free и дайджестов). */
export async function findLessons(env: Env, client: ItmoClient, f: LessonFilter) {
  const res = await loadSchedule(env, client, { buildings: f.buildings, ...rangeForWeeks(Math.min(LIMITS.maxWeeks, f.weeks ?? 2)) });
  return res.lessons.filter((l) => matchesFilter(l, f));
}

export async function createWatcher(env: Env, tgId: number, w: WatcherInput) {
  const existing = await listWatchers(env.DB, tgId);
  if (existing.length >= LIMITS.maxWatchers) throw new ValidationError(`Максимум ${LIMITS.maxWatchers} правил`);
  return insertWatcher(env.DB, tgId, w, nextRunAt(w, nowSec(), true));
}

export async function editWatcher(env: Env, tgId: number, id: number, w: WatcherInput) {
  await updateWatcher(env.DB, tgId, id, w, nextRunAt(w, nowSec(), true));
}

export async function createCatch(env: Env, tgId: number, l: Lesson) {
  const start = lessonStartUnix(l);
  if (start <= nowSec() + 60) throw new ValidationError("Занятие уже начинается");
  if ((await countActiveCatches(env.DB, tgId)) >= LIMITS.maxActiveCatches) throw new ValidationError(`Максимум ${LIMITS.maxActiveCatches} активных ловушек`);
  return insertCatch(env.DB, tgId, l, start);
}

export async function hasToken(env: Env, tgId: number) {
  return (await getUser(env.DB, tgId))?.token_status === "ok";
}
