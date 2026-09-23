// Запись/отписка с защитами для автоматических режимов.
import type { Lesson } from "../shared/types";
import { getUser, logSignup, parseSettings } from "./db";
import type { Env } from "./env";
import { ItmoError, TokenExpiredError, type ItmoClient } from "./itmo/client";
import { getAttempts, getChosen, signLessons, unsignLessons } from "./itmo/schedule";
import { lessonStartUnix } from "./rules";
import { addDays, isoWeekday, nowSec } from "./time";

export type SignSource = "manual" | "offer" | "auto" | "catch";

export interface SignResult {
  ok: boolean;
  /** skipped — сознательно не записали (лимит/пересечение), пробовать снова бессмысленно до изменений. */
  skipped?: boolean;
  /** ИТМО отказал именно из-за мест — ловушке имеет смысл пробовать дальше. */
  noSeats?: boolean;
  message: string;
}

/** error_code 9 у ИТМО — «На эту дату нет свободных мест». */
const isNoSeats = (e: ItmoError) => e.code === 9 || /нет свободных мест|мест нет/i.test(e.message);

type LessonRef = Pick<Lesson, "id" | "date" | "start" | "section"> & Partial<Pick<Lesson, "end" | "intersection">>;

const overlaps = (a: { start: string; end?: string }, b: { start: string; end?: string }) => {
  const aEnd = a.end || a.start;
  const bEnd = b.end || b.start;
  return a.start < bEnd && b.start < aEnd;
};

/** Лимит ИТМО: не больше стольких посещений в неделю. */
export const ITMO_WEEKLY_VISITS = 2;

/**
 * Проверки перед автозаписью — повторяют ограничения ИТМО, чтобы не слать заведомо отказные запросы.
 * Возвращает причину отказа или null.
 */
async function autoGuard(env: Env, client: ItmoClient, tgId: number, l: LessonRef): Promise<string | null> {
  const s = parseSettings((await getUser(env.DB, tgId))?.settings);
  if (l.intersection && !s.autoAllowIntersection) return "Занятие пересекается с парами — автозапись на такие выключена";

  const attempts = await getAttempts(client);
  if (attempts.free !== null && attempts.free <= 0) return "Записи в этом семестре закончились (лимит ИТМО)";
  if (attempts.free === 1 && !s.autoUseLastAttempt) return "Осталась последняя запись в семестре — её трачу только вручную";

  const chosen = await getChosen(client);
  if (chosen.some((c) => c.id === l.id && c.date === l.date)) return "Ты уже записан на это занятие";
  const clash = chosen.find((c) => c.date === l.date && overlaps(c, { start: l.start, end: l.end }));
  if (clash) return `Пересекается с твоей записью: ${clash.section} ${clash.start}`;
  const week = isoMonday(l.date);
  const sameWeek = chosen.filter((c) => isoMonday(c.date) === week).length;
  if (sameWeek >= ITMO_WEEKLY_VISITS) return `На этой неделе у тебя уже ${sameWeek} записи — больше ИТМО не даёт`;
  return null;
}

const isoMonday = (date: string) => addDays(date, 1 - isoWeekday(date));

export async function signUp(env: Env, client: ItmoClient, tgId: number, l: LessonRef, source: SignSource): Promise<SignResult> {
  if (lessonStartUnix(l) <= nowSec()) return { ok: false, skipped: true, message: "Занятие уже началось" };
  try {
    if (source === "auto" || source === "catch") {
      const reason = await autoGuard(env, client, tgId, l);
      if (reason) {
        await logSignup(env.DB, tgId, l, source, "sign", false, reason);
        return { ok: false, skipped: true, message: reason };
      }
    }
    await signLessons(client, [l.id]);
    await logSignup(env.DB, tgId, l, source, "sign", true, null);
    return { ok: true, message: "Записан" };
  } catch (e) {
    if (e instanceof TokenExpiredError) throw e;
    const message = e instanceof ItmoError ? e.message : `Ошибка: ${(e as Error).message}`;
    await logSignup(env.DB, tgId, l, source, "sign", false, message);
    if (!(e instanceof ItmoError)) throw e;
    return { ok: false, noSeats: isNoSeats(e), message };
  }
}

export async function unsign(env: Env, client: ItmoClient, tgId: number, l: Pick<LessonRef, "id"> & Partial<LessonRef>): Promise<SignResult> {
  try {
    await unsignLessons(client, [l.id]);
    await logSignup(env.DB, tgId, l, "manual", "unsign", true, null);
    return { ok: true, message: "Запись отменена" };
  } catch (e) {
    if (!(e instanceof ItmoError)) throw e;
    await logSignup(env.DB, tgId, l, "manual", "unsign", false, e.message);
    return { ok: false, message: e.message };
  }
}
