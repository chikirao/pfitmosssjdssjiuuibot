// Запись/отписка с защитами для автоматических режимов.
import type { Lesson } from "../shared/types";
import { countAutoSignupsSince, getUser, logSignup, parseSettings } from "./db";
import type { Env } from "./env";
import { ItmoError, type ItmoClient } from "./itmo/client";
import { getAttempts, getChosen, signLessons, unsignLessons } from "./itmo/schedule";
import { lessonStartUnix } from "./rules";
import { mskWeekStartUnix, nowSec } from "./time";

export type SignSource = "manual" | "offer" | "auto" | "catch";

export interface SignResult {
  ok: boolean;
  /** skipped — сознательно не записали (лимит/пересечение), пробовать снова бессмысленно до изменений. */
  skipped?: boolean;
  message: string;
}

type LessonRef = Pick<Lesson, "id" | "date" | "start" | "section"> & Partial<Pick<Lesson, "end" | "intersection">>;

const overlaps = (a: { start: string; end?: string }, b: { start: string; end?: string }) => {
  const aEnd = a.end || a.start;
  const bEnd = b.end || b.start;
  return a.start < bEnd && b.start < aEnd;
};

/** Проверки перед автозаписью. Возвращает причину отказа или null. */
async function autoGuard(env: Env, client: ItmoClient, tgId: number, l: LessonRef): Promise<string | null> {
  const s = parseSettings((await getUser(env.DB, tgId))?.settings);
  if (s.autoWeeklyLimit <= 0) return "Автозапись выключена в настройках (лимит 0 в неделю)";
  const used = await countAutoSignupsSince(env.DB, tgId, mskWeekStartUnix());
  if (used >= s.autoWeeklyLimit) return `Лимит автозаписей на эту неделю исчерпан (${used}/${s.autoWeeklyLimit})`;
  if (l.intersection && !s.autoAllowIntersection) return "Занятие пересекается с парами — автозапись на такие выключена";

  const attempts = await getAttempts(client);
  if (attempts.free !== null && attempts.free <= 0) return "Записи в этом семестре закончились (лимит ИТМО)";
  if (attempts.free === 1 && !s.autoUseLastAttempt) return "Осталась последняя запись в семестре — её трачу только вручную";

  const chosen = await getChosen(client);
  const clash = chosen.find((c) => c.date === l.date && overlaps(c, { start: l.start, end: l.end }));
  if (clash) return clash.id === l.id ? "Ты уже записан на это занятие" : `Пересекается с твоей записью: ${clash.section} ${clash.start}`;
  return null;
}

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
    const message = e instanceof ItmoError ? e.message : `Ошибка: ${(e as Error).message}`;
    await logSignup(env.DB, tgId, l, source, "sign", false, message);
    if (!(e instanceof ItmoError)) throw e;
    return { ok: false, message };
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
