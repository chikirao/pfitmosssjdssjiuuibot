// Cron раз в минуту: обновление токенов, «поймать место», правила уведомлений, раз в 12 ч — баллы.
import { Api, InlineKeyboard } from "grammy";
import type { Lesson } from "../shared/types";
import { appUrl } from "./bot";
import { esc, humanDate, lessonBlock, lessonLine, plural } from "./bot/format";
import {
  activeCatches,
  type CatchWithOwner,
  cleanup,
  dueScoreUsers,
  dueWatchers,
  finishCatch,
  getSeen,
  getUser,
  insertOffer,
  markWatcherRun,
  parseSettings,
  replaceSeen,
  saveScoreCheck,
  saveSettings,
  setCatchOpen,
  touchCatch,
  type UserRow,
  usersWithTokens,
  type WatcherWithOwner,
} from "./db";
import type { Env } from "./env";
import { Budget, BudgetExceeded, ItmoError, TokenExpiredError } from "./itmo/client";
import { fetchSchedule, getLimits, getScore, rangeForWeeks, scheduleCost, seatsFor } from "./itmo/schedule";
import { itmoFor, keepAlive } from "./itmo/session";
import { isOpen, isQuiet, lessonStartUnix, matchesFilter, nextRunAt, nextScheduleRun } from "./rules";
import { signUp } from "./signup";
import { nowSec } from "./time";

class Notifier {
  private api: Api;
  constructor(
    private env: Env,
    private budget: Budget,
  ) {
    this.api = new Api(env.BOT_TOKEN);
  }
  /** Ошибки Telegram (бот заблокирован, сеть) не должны ломать обработку остальных правил. */
  async send(chatId: number, text: string, kb?: InlineKeyboard, silent = false) {
    this.budget.take();
    try {
      await this.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb, disable_notification: silent, link_preview_options: { is_disabled: true } });
      return true;
    } catch (e) {
      console.warn("telegram send", chatId, (e as Error).message);
      return false;
    }
  }
  appKb(label = "Открыть мини-апп") {
    const url = appUrl(this.env);
    return url ? new InlineKeyboard().webApp(label, url) : undefined;
  }
}

export async function runScheduled(env: Env) {
  const now = nowSec();
  const budget = new Budget(Number(env.SUBREQUEST_BUDGET) || 40);
  const tg = new Notifier(env, budget);
  await cleanup(env.DB, now);

  try {
    await refreshTokens(env, budget, tg);
    await runCatches(env, budget, tg);
    await runWatchers(env, budget, tg, now);
    await runScores(env, budget, tg, now);
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    console.warn("scheduler: budget exhausted, остальное — в следующую минуту");
  }
}

// ---------- tokens ----------

async function alertTokenDead(env: Env, tg: Notifier, row: UserRow) {
  if (row.token_alerted) return;
  await env.DB.prepare("UPDATE users SET token_alerted = 1 WHERE tg_id = ?").bind(row.tg_id).run();
  await tg.send(row.tg_id, "🔑 Сессия ИТМО закончилась — токен больше не обновляется. Пришли новый: /token\n\nПока токена нет, правила и ловушки на паузе.");
}

async function refreshTokens(env: Env, budget: Budget, tg: Notifier) {
  for (const row of await usersWithTokens(env.DB)) {
    try {
      await keepAlive(env, row, budget);
    } catch (e) {
      if (e instanceof TokenExpiredError) await alertTokenDead(env, tg, (await getUser(env.DB, row.tg_id)) ?? row);
      else if (e instanceof BudgetExceeded) throw e;
      else console.warn("keepAlive", row.tg_id, (e as Error).message);
    }
  }
}

// ---------- catches ----------

async function runCatches(env: Env, budget: Budget, tg: Notifier) {
  const byUser = new Map<number, CatchWithOwner[]>();
  for (const c of await activeCatches(env.DB)) byUser.set(c.tgId, [...(byUser.get(c.tgId) ?? []), c]);

  for (const [tgId, catches] of byUser) {
    if (!budget.has(4)) return;
    const client = itmoFor(env, tgId, budget);
    const user = await getUser(env.DB, tgId);
    if (user && parseSettings(user.settings).exempt) continue; // освобождение — ловушки спят
    const silent = !!user && (user.paused_until > nowSec() || isQuiet(parseSettings(user.settings)));
    try {
      const limits = await getLimits(client);
      for (const c of catches) {
        const seats = seatsFor(limits, { id: c.lessonId, lesson_group_id: c.groupId ?? undefined });
        if (c.mode === "notify") {
          // только сообщаем — и только на переход «мест нет → есть»; в тишину ждём, пока она кончится
          const open = seats.available > 0;
          if (open && !c.lastOpen && !silent) {
            await setCatchOpen(env.DB, c.id, true);
            await tg.send(
              tgId,
              `🔔 Появилось место: <b>${esc(c.section)}</b> — ${humanDate(c.date)}, ${esc(c.start)}${c.end ? "–" + esc(c.end) : ""}\nСвободно ${seats.available} из ${seats.limit}`,
              new InlineKeyboard().text("✅ Записать", `cs:${c.id}`).text("Хватит следить", `cx:${c.id}`),
            );
          } else if (!open && c.lastOpen) await setCatchOpen(env.DB, c.id, false);
          else await touchCatch(env.DB, c.id);
          continue;
        }
        if (seats.available <= 0) {
          await touchCatch(env.DB, c.id);
          continue;
        }
        if (!budget.has(5)) return;
        const r = await signUp(env, client, tgId, { id: c.lessonId, date: c.date, start: c.start, end: c.end ?? undefined, section: c.section }, "catch");
        const when = `${humanDate(c.date)}, ${esc(c.start)}`;
        if (r.ok) {
          await finishCatch(env.DB, c.id, "done", "Записан");
          await tg.send(tgId, `🎯 Поймал! Записал тебя: <b>${esc(c.section)}</b> — ${when}`, new InlineKeyboard().text("Отменить запись", `u:${c.lessonId}`));
        } else if (r.skipped) {
          const done = r.message.startsWith("Ты уже записан");
          await finishCatch(env.DB, c.id, done ? "done" : "failed", r.message);
          await tg.send(tgId, `${done ? "✅" : "🎯 Место появилось, но не записал"}: <b>${esc(c.section)}</b> — ${when}\n${esc(r.message)}`, done ? undefined : tg.appKb());
        } else if (r.noSeats) {
          // место успели занять раньше нас — продолжаем ловить
          await touchCatch(env.DB, c.id);
        } else {
          // ИТМО отказал по другой причине (лимиты, отбор, долги) — повторять бессмысленно
          await finishCatch(env.DB, c.id, "failed", r.message);
          await tg.send(tgId, `🎯 Место появилось, но ИТМО не дал записаться: <b>${esc(c.section)}</b> — ${when}\n${esc(r.message)}\n\nЛовушку снял.`, tg.appKb());
        }
      }
    } catch (e) {
      if (e instanceof TokenExpiredError) await alertTokenDead(env, tg, (await getUser(env.DB, tgId))!);
      else if (e instanceof BudgetExceeded) throw e;
      else console.warn("catches", tgId, (e as Error).message);
    }
  }
}

// ---------- баллы ----------

const SCORE_EVERY = 12 * 3600;
const pts = (n: number) => String(Math.round(n * 10) / 10);
const signed = (n: number) => (n > 0 ? "+" : "−") + pts(Math.abs(n));

interface ScoreSnap {
  attendance: number;
  other: number;
  semesterId: number | null;
}

/** Раз в 12 часов сверяем баллы: пишем, если изменились; при освобождении — напоминаем о новом семестре. */
async function runScores(env: Env, budget: Budget, tg: Notifier, now: number) {
  for (const user of await dueScoreUsers(env.DB, now)) {
    if (!budget.has(3)) return;
    const tgId = user.tg_id;
    let cur: Awaited<ReturnType<typeof getScore>>;
    try {
      cur = await getScore(itmoFor(env, tgId, budget));
    } catch (e) {
      if (e instanceof TokenExpiredError) await alertTokenDead(env, tg, user);
      else if (e instanceof BudgetExceeded) throw e;
      else console.warn("score", tgId, (e as Error).message);
      await saveScoreCheck(env.DB, tgId, null, now + 3600);
      continue;
    }
    if (cur.attendance === null) {
      await saveScoreCheck(env.DB, tgId, null, now + 3600); // ИТМО не ответил — попробуем через час
      continue;
    }
    const snap: ScoreSnap = { attendance: cur.attendance, other: cur.other ?? 0, semesterId: cur.semesterId };
    let prev: ScoreSnap | null = null;
    try {
      prev = user.score_last ? (JSON.parse(user.score_last) as ScoreSnap) : null;
    } catch {
      /* битое — считаем первым прогоном */
    }
    const settings = parseSettings(user.settings);
    const store = () => saveScoreCheck(env.DB, tgId, JSON.stringify(snap), now + SCORE_EVERY);

    // первый прогон — только запоминаем
    if (!prev) {
      await store();
      continue;
    }
    const newSemester = prev.semesterId !== snap.semesterId;
    const dA = snap.attendance - prev.attendance;
    const dO = snap.other - prev.other;
    const hasNews = newSemester ? settings.exempt : Math.abs(dA) >= 0.05 || Math.abs(dO) >= 0.05;
    if (!hasNews) {
      await store();
      continue;
    }
    // тишина или пауза — не теряем новость, проверим снова через полчаса
    if (user.paused_until > now || isQuiet(settings, now)) {
      await saveScoreCheck(env.DB, tgId, null, now + 1800);
      continue;
    }

    if (newSemester) {
      await saveSettings(env.DB, tgId, { ...settings, theory: [] });
      await tg.send(
        tgId,
        `🗓 Новый семестр по физре${cur.semester ? ` — <b>${esc(cur.semester)}</b>` : ""}. Теоретический зачёт оформляется заново:\n\n` +
          `1. Справка у врача СК «Вяземский» — в течение 2 недель с даты освобождения\n` +
          `2. Заявка в my.itmo: Спорт → Записаться → Спецпроекты → Теоретический зачёт (со справкой)\n` +
          `3. Дальше преподаватель напишет на почту\n\nЧек-лист в «Моих» сбросил.`,
        tg.appKb(),
      );
    } else {
      const total = snap.attendance + snap.other;
      const parts = [dA ? `${signed(dA)} за посещения` : "", dO ? `${signed(dO)} ${dA ? "доп." : "дополнительных"}` : ""].filter(Boolean);
      const graded = settings.exempt && dO > 0 ? "\nПохоже, оценили работу по теоретическому зачёту 🎉" : "";
      await tg.send(tgId, `📈 Баллы по физре: ${parts.join(", ")}\nТеперь <b>${pts(total)}</b> из 100${graded}`, tg.appKb());
    }
    await store();
  }
}

// ---------- watchers ----------

async function runWatchers(env: Env, budget: Budget, tg: Notifier, now: number) {
  const byUser = new Map<number, WatcherWithOwner[]>();
  for (const w of await dueWatchers(env.DB, now)) byUser.set(w.tgId, [...(byUser.get(w.tgId) ?? []), w]);

  for (const [tgId, watchers] of byUser) {
    const user = await getUser(env.DB, tgId);
    if (!user || parseSettings(user.settings).exempt) continue;
    const allBuildings = watchers.some((w) => !w.filter.buildings?.length);
    const buildings = allBuildings ? [] : [...new Set(watchers.flatMap((w) => w.filter.buildings ?? []))];
    const weeks = Math.max(...watchers.map((w) => w.filter.weeks ?? 2));
    // «все корпуса» — не знаем точное число без справочника; берём с запасом 8
    if (!budget.has(scheduleCost(allBuildings ? 8 : buildings.length, weeks) + 3)) return;

    let lessons: Lesson[];
    try {
      lessons = (await fetchSchedule(itmoFor(env, tgId, budget), env.DB, { buildings, ...rangeForWeeks(weeks) })).lessons;
    } catch (e) {
      if (e instanceof TokenExpiredError) await alertTokenDead(env, tg, user);
      else if (e instanceof BudgetExceeded) throw e;
      else console.warn("watchers fetch", tgId, (e as Error).message);
      continue;
    }

    const settings = parseSettings(user.settings);
    const silent = user.paused_until > now || isQuiet(settings, now);
    for (const w of watchers) {
      try {
        await runWatcher(env, budget, tg, w, lessons.filter((l) => matchesFilter(l, w.filter)), silent, now);
      } catch (e) {
        if (e instanceof BudgetExceeded) throw e;
        console.warn("watcher", w.id, (e as Error).message);
      }
    }
  }
}

async function offerKb(env: Env, w: WatcherWithOwner, l: Lesson, withMute: boolean) {
  const id = await insertOffer(env.DB, w.tgId, w.id, l, lessonStartUnix(l));
  const kb = new InlineKeyboard().text("✅ Записать", `o:${id}:y`).text("✖ Нет", `o:${id}:n`);
  if (withMute) kb.row().text("🔕 Выключить это правило", `wm:${w.id}`);
  return kb;
}

async function runWatcher(env: Env, budget: Budget, tg: Notifier, w: WatcherWithOwner, matched: Lesson[], silent: boolean, now: number) {
  const open = matched.filter(isOpen);

  // --- дайджест по расписанию ---
  if (w.mode === "schedule") {
    if (!budget.has(2)) throw new BudgetExceeded();
    const shown = open.slice(0, 15);
    const head = `📅 <b>${esc(w.name)}</b>: ${open.length ? `свободно ${open.length} ${plural(open.length, "занятие", "занятия", "занятий")}` : "свободных мест нет"}`;
    let kb: InlineKeyboard | undefined;
    if (w.action !== "notify" && shown.length) {
      kb = new InlineKeyboard();
      for (const l of shown.slice(0, 8)) {
        const id = await insertOffer(env.DB, w.tgId, w.id, l, lessonStartUnix(l));
        kb.text(`✅ ${l.section.slice(0, 16)} ${humanDate(l.date).split(",")[0]} ${l.start}`, `o:${id}:y`).row();
      }
    }
    await tg.send(w.tgId, `${head}${shown.length ? `\n\n${shown.map((l, i) => lessonLine(l, i)).join("\n")}` : ""}${open.length > shown.length ? `\n…и ещё ${open.length - shown.length}` : ""}`, kb ?? tg.appKb("Открыть расписание"));
    await markWatcherRun(env.DB, w.id, now, nextScheduleRun(w.schedule!, now));
    return;
  }

  // --- интервальная проверка: реагируем на переход «закрыто → открыто» ---
  const prev = await getSeen(env.DB, w.id);
  const state = new Map<string, boolean>();
  const fresh: Lesson[] = [];
  for (const l of matched) {
    const o = isOpen(l);
    state.set(l.key, o);
    if (o && w.primed && prev.get(l.key) !== true) fresh.push(l);
  }

  if (!w.primed) {
    // первый прогон: присылаем, что открыто прямо сейчас, без автозаписи
    if (open.length && !silent) {
      if (!budget.has(2)) throw new BudgetExceeded();
      await tg.send(
        w.tgId,
        `🟢 Правило «${esc(w.name)}» запущено. Сейчас свободно ${open.length}:\n\n${open.slice(0, 10).map((l, i) => lessonLine(l, i)).join("\n")}\n\nДальше напишу, когда появятся новые места.`,
        tg.appKb("Открыть расписание"),
      );
    }
  } else {
    const toSend = fresh.slice(0, 5);
    if (!budget.has(toSend.length * (w.action === "auto" ? 5 : 1) + 1)) throw new BudgetExceeded();
    for (const l of toSend) {
      if (w.action === "auto") {
        const r = await signUp(env, itmoFor(env, w.tgId, budget), w.tgId, l, "auto");
        if (r.ok) {
          await tg.send(w.tgId, `⚡ Записал автоматически:\n\n${lessonBlock(l)}`, new InlineKeyboard().text("Отменить запись", `u:${l.id}`), silent);
          continue;
        }
        if (silent) {
          state.set(l.key, false); // напомним после тишины
          continue;
        }
        await tg.send(w.tgId, `⚡ Место появилось, но автозапись не сработала: ${esc(r.message)}\n\n${lessonBlock(l)}\n\nЗаписать вручную?`, await offerKb(env, w, l, false));
      } else if (silent) {
        state.set(l.key, false);
      } else if (w.action === "offer") {
        await tg.send(w.tgId, `🟢 Освободилось место — записать вас?\n\n${lessonBlock(l)}`, await offerKb(env, w, l, true));
      } else {
        await tg.send(w.tgId, `🟢 Освободилось место\n\n${lessonBlock(l)}`, tg.appKb("Открыть расписание"));
      }
    }
    // не влезло в лимит сообщений — пусть придут в следующий раз
    for (const l of fresh.slice(5)) state.set(l.key, false);
  }

  await replaceSeen(env.DB, w.id, state);
  await markWatcherRun(env.DB, w.id, now, nextRunAt(w, now));
}

export { ItmoError };
