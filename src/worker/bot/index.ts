import { Bot, InlineKeyboard, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { WatcherInput } from "../../shared/types";
import {
  cancelCatch,
  deleteUser,
  finishCatch,
  getCatch,
  deleteWatcher,
  getUser,
  getWatcher,
  insertOffer,
  listCatches,
  listWatchers,
  parseSettings,
  setOfferStatus,
  setPaused,
  setWatcherEnabled,
  takeOffer,
  upsertUser,
} from "../db";
import { type Env, isAllowed } from "../env";
import { ItmoError, TokenExpiredError } from "../itmo/client";
import { getAttempts, getChosen, getScore } from "../itmo/schedule";
import { itmoFor } from "../itmo/session";
import { describeWatcher, isOpen, lessonStartUnix, nextRunAt } from "../rules";
import { acceptTokenInput, createWatcher, editWatcher, findLessons, TokenInputError, tokenStatus, ValidationError } from "../services";
import { signUp, unsign } from "../signup";
import { nowSec } from "../time";
import { buttonLabel, chosenLine, esc, humanDate, lessonLine, plural, TOKEN_SCRIPT } from "./format";
import { catchesHtml, freeHtml, guideFallback, guideHtml, helpFallback, helpHtml, myHtml, replyRich, settingsHtml } from "./rich";

let botInfo: UserFromGetMe | undefined;

export function appUrl(env: Env, origin?: string) {
  return (env.APP_URL || origin || "").replace(/\/$/, "");
}

/** Всё, что похоже на JWT ITMO ID. */
const looksLikeToken = (t: string) => /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/.test(t);

function itmoErrorText(e: unknown): string {
  if (e instanceof TokenExpiredError) return `🔑 ${e.message}`;
  if (e instanceof ItmoError) return `⚠️ ${e.message}`;
  if (e instanceof ValidationError || e instanceof TokenInputError) return `⚠️ ${e.message}`;
  console.error("bot error", e);
  return "⚠️ Что-то пошло не так, попробуй ещё раз";
}

// ---------- watcher editor (inline) ----------

function watcherKeyboard(w: WatcherInput & { id: number }) {
  const kb = new InlineKeyboard();
  const mark = (cond: boolean, s: string) => (cond ? `• ${s}` : s);
  if (w.mode === "interval") {
    for (const m of [5, 15, 30, 60]) kb.text(mark(w.intervalMin === m, `${m} мин`), `we:${w.id}:i:${m}`);
    kb.row();
  } else {
    for (const t of ["07:30", "08:00", "12:00", "20:00"]) kb.text(mark(w.schedule?.time === t, t), `we:${w.id}:t:${t.replace(":", "")}`);
    kb.row();
  }
  kb.text(mark(w.mode === "interval", "⏱ По интервалу"), `we:${w.id}:m:i`).text(mark(w.mode === "schedule", "📅 По расписанию"), `we:${w.id}:m:s`).row();
  kb.text(mark(w.action === "notify", "🔔 Сообщать"), `we:${w.id}:a:n`).text(mark(w.action === "offer", "❓ Предлагать"), `we:${w.id}:a:o`);
  if (w.mode === "interval") kb.text(mark(w.action === "auto", "⚡ Авто"), `we:${w.id}:a:a`);
  kb.row();
  kb.text(w.enabled ? "⏸ Выключить" : "▶️ Включить", `we:${w.id}:e`).text("🗑 Удалить", `wd:${w.id}`).style("danger");
  return kb;
}

const watcherText = (w: WatcherInput & { id: number }) =>
  `${w.enabled ? "🟢" : "⚪️"} <b>${esc(w.name)}</b>\n${esc(describeWatcher(w))}${w.filter.query ? `\nПоиск: «${esc(w.filter.query)}»` : ""}\n\n<i>Тонкая настройка (дни, время, корпуса) — в мини-аппе.</i>`;

// ---------- bot ----------

export function createBot(env: Env, origin?: string) {
  const bot = new Bot(env.BOT_TOKEN, { botInfo });
  const url = appUrl(env, origin);

  // Только личка и только вайтлист. Остальным — ничего, кроме id в ответ на /start.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") return;
    const id = ctx.from?.id;
    if (!isAllowed(env, id)) {
      if (ctx.message?.text?.startsWith("/start")) await ctx.reply(`Это приватный бот. Твой id: <code>${id}</code>`, { parse_mode: "HTML" });
      else if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Нет доступа" });
      return;
    }
    await upsertUser(env.DB, { id, first_name: ctx.from?.first_name, username: ctx.from?.username });
    await next();
  });

  const client = (ctx: Context) => itmoFor(env, ctx.from!.id);
  const openAppKb = (path = "") => (url ? new InlineKeyboard().webApp("Открыть мини-апп", `${url}/${path}`) : undefined);

  async function sendHelp(ctx: Context) {
    const st = tokenStatus(await getUser(env.DB, ctx.from!.id));
    const tokenLine =
      st.status === "ok" ? "🔑 Токен ИТМО подключён — всё работает." : st.status === "expired" ? "🔑 Токен ИТМО истёк — пришли новый, инструкция: /guide" : "🔑 Токен ИТМО ещё не добавлен — начни с /guide.";
    const kb = new InlineKeyboard();
    if (url) kb.webApp("Открыть мини-апп", url).style("primary").row();
    if (st.status === "ok") kb.text("🟢 Что свободно", "free").text("📋 Мои записи", "my");
    else kb.text("📖 Как подключить токен", "guide").style("success");
    await replyRich(ctx, helpHtml(tokenLine), helpFallback(tokenLine), { reply_markup: kb });
  }

  async function sendGuide(ctx: Context) {
    const st = tokenStatus(await getUser(env.DB, ctx.from!.id));
    const status =
      st.status === "ok"
        ? `Сейчас токен ✅ подключён${st.refreshExp === null ? ", но без refresh — умрёт через ~30 мин. Пройди шаги заново" : ". Если прислать новый — заменю"}.`
        : st.status === "expired"
          ? "Сейчас токен ❌ истёк — пройди шаги заново."
          : "Сейчас токена нет.";
    const kb = new InlineKeyboard().url("Открыть my.itmo.ru", "https://my.itmo.ru/sport/sign");
    if (url) kb.webApp("Мини-апп", url);
    await replyRich(ctx, guideHtml(url, status, TOKEN_SCRIPT), guideFallback(status, TOKEN_SCRIPT), { reply_markup: kb });
  }

  bot.command(["start", "help"], sendHelp);
  bot.command("guide", sendGuide);

  bot.command("token", async (ctx) => {
    const arg = ctx.match?.trim();
    if (arg && looksLikeToken(arg)) return handleToken(ctx, arg);
    await sendGuide(ctx);
  });

  async function handleToken(ctx: Context, text: string) {
    // удаляем сообщение с токеном в любом случае
    await ctx.deleteMessage().catch(() => {});
    try {
      const r = await acceptTokenInput(env, ctx.from!.id, text);
      await ctx.reply(`✅ ${r.message}\n\n<i>Сообщение с токеном удалено.</i>`, { parse_mode: "HTML" });
    } catch (e) {
      await ctx.reply(`${itmoErrorText(e)}\n\n<i>Сообщение с токеном удалено.</i>`, { parse_mode: "HTML" });
    }
  }

  async function sendFree(ctx: Context, q?: string) {
    await ctx.replyWithChatAction("typing");
    try {
      const lessons = (await findLessons(env, client(ctx), { query: q || undefined, weeks: 2 })).filter(isOpen);
      if (!lessons.length) return ctx.reply(q ? `По «${esc(q)}» свободных мест нет.` : "Свободных мест сейчас нет.", { parse_mode: "HTML" });
      const shown = lessons.slice(0, 12);
      const kb = new InlineKeyboard();
      for (const l of shown) {
        const id = await insertOffer(env.DB, ctx.from!.id, null, l, lessonStartUnix(l));
        kb.text(buttonLabel(l, "✅ "), `o:${id}:y`).style("success").row();
      }
      if (url) kb.webApp("Все занятия в мини-аппе", url);
      const more = lessons.length > shown.length ? `\n\n…и ещё ${lessons.length - shown.length}. Полный список — в мини-аппе.` : "";
      await replyRich(
        ctx,
        freeHtml(shown, lessons.length, q),
        `<b>Свободно${q ? ` по «${esc(q)}»` : ""}: ${lessons.length} ${plural(lessons.length, "занятие", "занятия", "занятий")}</b>\n\n${shown.map((l, i) => lessonLine(l, i)).join("\n")}${more}\n\nНажми, чтобы записаться:`,
        { reply_markup: kb },
      );
    } catch (e) {
      await ctx.reply(itmoErrorText(e), { parse_mode: "HTML" });
    }
  }

  async function sendMy(ctx: Context) {
    try {
      const c = client(ctx);
      const [chosen, attempts, score] = await Promise.all([getChosen(c), getAttempts(c), getScore(c)]);
      const future = chosen.filter((l) => lessonStartUnix(l) > nowSec());
      const att = attempts.free !== null ? `\nОсталось записей в семестре: <b>${attempts.free}</b>${attempts.total !== null ? ` из ${attempts.total}` : ""} (и не больше 2 в неделю)` : "";
      const kb = new InlineKeyboard();
      future.slice(0, 10).forEach((l) => kb.text(buttonLabel(l, "✖ "), `u:${l.id}`).style("danger").row());
      if (url) kb.webApp("Открыть «Мои»", `${url}/#my`);
      await replyRich(ctx, myHtml(future, attempts, score), future.length ? `<b>Мои записи</b>\n\n${future.map(chosenLine).join("\n")}${att}\n\nОтписаться:` : `Предстоящих записей нет.${att}`, {
        reply_markup: kb,
      });
    } catch (e) {
      await ctx.reply(itmoErrorText(e), { parse_mode: "HTML" });
    }
  }

  bot.command("free", (ctx) => sendFree(ctx, ctx.match?.trim()));
  bot.command("my", sendMy);
  bot.callbackQuery("free", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendFree(ctx);
  });
  bot.callbackQuery("my", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendMy(ctx);
  });
  bot.callbackQuery("guide", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendGuide(ctx);
  });

  bot.command("watch", async (ctx) => {
    const q = ctx.match?.trim();
    if (!q) return ctx.reply("Напиши, что искать: <code>/watch йога</code>\nПравило можно донастроить кнопками или в мини-аппе.", { parse_mode: "HTML" });
    try {
      const w: WatcherInput = { name: q.slice(0, 60), enabled: true, filter: { query: q.slice(0, 120), weeks: 2 }, mode: "interval", intervalMin: 15, schedule: null, action: "offer" };
      const id = await createWatcher(env, ctx.from!.id, w);
      await ctx.reply(`Правило создано.\n\n${watcherText({ ...w, id })}`, { parse_mode: "HTML", reply_markup: watcherKeyboard({ ...w, id }) });
    } catch (e) {
      await ctx.reply(itmoErrorText(e), { parse_mode: "HTML" });
    }
  });

  bot.command("watches", async (ctx) => {
    const ws = await listWatchers(env.DB, ctx.from!.id);
    if (!ws.length) return ctx.reply("Правил пока нет. Создай: <code>/watch йога</code> или в мини-аппе.", { parse_mode: "HTML", reply_markup: openAppKb("#alerts") });
    for (const w of ws) await ctx.reply(watcherText(w), { parse_mode: "HTML", reply_markup: watcherKeyboard(w) });
  });

  bot.command("catches", async (ctx) => {
    const cs = await listCatches(env.DB, ctx.from!.id, false);
    if (!cs.length) return ctx.reply("Ничего не отслеживаю. Открой занятие без мест в мини-аппе: «Поймать место» (запишу сам) или «Сообщить о месте».", { reply_markup: openAppKb() });
    const kb = new InlineKeyboard();
    cs.forEach((c) => kb.text(`✖ ${buttonLabel(c)}`, `cx:${c.id}`).style("danger").row());
    await replyRich(
      ctx,
      catchesHtml(cs),
      `<b>Слежу за занятиями</b> (проверка раз в минуту):\n\n${cs.map((c) => `${c.mode === "notify" ? "🔔" : "🎯"} <b>${esc(c.section)}</b> — ${humanDate(c.date)}, ${esc(c.start)}`).join("\n")}\n\n🎯 — запишу сам, 🔔 — сообщу о месте. Отменить:`,
      { reply_markup: kb },
    );
  });

  bot.command("pause", async (ctx) => {
    const h = Math.min(24 * 14, Math.max(1, Number(ctx.match) || 8));
    await setPaused(env.DB, ctx.from!.id, nowSec() + h * 3600);
    await ctx.reply(`🔕 Тишина на ${h} ${plural(h, "час", "часа", "часов")}. Ловушки и автозапись продолжают работать. /resume — вернуть уведомления.`);
  });

  bot.command("resume", async (ctx) => {
    await setPaused(env.DB, ctx.from!.id, 0);
    await ctx.reply("🔔 Уведомления снова включены.");
  });

  bot.command("settings", async (ctx) => {
    const row = await getUser(env.DB, ctx.from!.id);
    const s = parseSettings(row?.settings);
    await replyRich(
      ctx,
      settingsHtml(s, row?.paused_until ?? 0, nowSec()),
      `<b>Настройки</b>\nТратить последнюю запись семестра: <b>${s.autoUseLastAttempt ? "да" : "нет"}</b>\nАвтозапись при пересечении с парами: <b>${s.autoAllowIntersection ? "да" : "нет"}</b>\nТихие часы: <b>${s.quietFrom && s.quietTo ? `${s.quietFrom}–${s.quietTo}` : "выкл"}</b>\n\nМенять — в мини-аппе, вкладка «Профиль».`,
      { reply_markup: openAppKb("#profile") },
    );
  });

  bot.command("forget", async (ctx) => {
    await ctx.reply("Удалить токен, правила, ловушки и историю? Это нельзя отменить.", {
      reply_markup: new InlineKeyboard().text("Да, удалить всё", "forget:yes").style("danger").text("Отмена", "forget:no"),
    });
  });

  // ---------- callbacks ----------

  bot.callbackQuery(/^o:(\d+):(y|n)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const yes = ctx.match[2] === "y";
    const offer = await takeOffer(env.DB, ctx.from.id, id, yes ? "accepted" : "declined");
    if (!offer) return ctx.answerCallbackQuery({ text: "Предложение устарело" });
    if (!yes) {
      await ctx.answerCallbackQuery({ text: "Ок, не записываю" });
      return ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    }
    await ctx.answerCallbackQuery({ text: "Записываю…" });
    try {
      const r = await signUp(env, client(ctx), ctx.from.id, offer.lesson, "offer");
      await setOfferStatus(env.DB, id, r.ok ? "accepted" : "failed");
      const l = offer.lesson;
      await ctx.reply(r.ok ? `✅ Записан: <b>${esc(l.section)}</b>, ${humanDate(l.date)} ${esc(l.start)}` : `❌ Не получилось записаться на ${esc(l.section)} ${esc(l.start)}: ${esc(r.message)}`, {
        parse_mode: "HTML",
        reply_markup: r.ok ? new InlineKeyboard().text("Отменить запись", `u:${l.id}`) : undefined,
      });
    } catch (e) {
      await setOfferStatus(env.DB, id, "failed");
      await ctx.reply(itmoErrorText(e), { parse_mode: "HTML" });
    }
  });

  // отписка — в два шага, чтобы не отписаться случайным тапом
  bot.callbackQuery(/^u:(\d+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.reply("Точно отписаться от этого занятия?", { reply_markup: new InlineKeyboard().text("Да, отписаться", `U:${id}`).style("danger").text("Нет", "noop") });
  });

  bot.callbackQuery(/^U:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: "Отписываю…" });
    try {
      const r = await unsign(env, client(ctx), ctx.from.id, { id });
      await ctx.editMessageText(r.ok ? "✅ Запись отменена" : `❌ ${esc(r.message)}`, { parse_mode: "HTML" });
    } catch (e) {
      await ctx.editMessageText(itmoErrorText(e), { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery("noop", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.deleteMessage().catch(() => {});
  });

  bot.callbackQuery(/^cx:(\d+)$/, async (ctx) => {
    await cancelCatch(env.DB, ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: "Больше не слежу" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // «Записать» из уведомления о месте (ловушка в режиме notify)
  bot.callbackQuery(/^cs:(\d+)$/, async (ctx) => {
    const c = await getCatch(env.DB, ctx.from.id, Number(ctx.match[1]));
    if (!c || c.status !== "active") return ctx.answerCallbackQuery({ text: "Уже неактуально" });
    await ctx.answerCallbackQuery({ text: "Записываю…" });
    try {
      const r = await signUp(env, client(ctx), ctx.from.id, { id: c.lessonId, date: c.date, start: c.start, end: c.end ?? undefined, section: c.section }, "offer");
      if (r.ok || r.message.startsWith("Ты уже записан")) {
        await finishCatch(env.DB, c.id, "done", "Записан");
        await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      }
      await ctx.reply(
        r.ok
          ? `✅ Записан: <b>${esc(c.section)}</b>, ${humanDate(c.date)} ${esc(c.start)}`
          : `❌ Не получилось: ${esc(r.message)}${r.noSeats ? "\nМесто уже заняли — продолжаю следить." : ""}`,
        { parse_mode: "HTML", reply_markup: r.ok ? new InlineKeyboard().text("Отменить запись", `u:${c.lessonId}`) : undefined },
      );
    } catch (e) {
      await ctx.reply(itmoErrorText(e), { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery(/^wd:(\d+)(:y)?$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!ctx.match[2]) {
      await ctx.answerCallbackQuery();
      return ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("Да, удалить правило", `wd:${id}:y`).style("danger").text("Отмена", `we:${id}:r`) });
    }
    await deleteWatcher(env.DB, ctx.from.id, id);
    await ctx.answerCallbackQuery({ text: "Удалено" });
    await ctx.editMessageText("🗑 Правило удалено");
  });

  bot.callbackQuery(/^we:(\d+):(\w)(?::(\w+))?$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const w = await getWatcher(env.DB, ctx.from.id, id);
    if (!w) return ctx.answerCallbackQuery({ text: "Правило не найдено" });
    const op = ctx.match[2];
    const v = ctx.match[3];
    const next: WatcherInput = { name: w.name, enabled: w.enabled, filter: w.filter, mode: w.mode, intervalMin: w.intervalMin, schedule: w.schedule, action: w.action };
    if (op === "i") next.intervalMin = Number(v);
    if (op === "t") next.schedule = { days: w.schedule?.days ?? [], time: `${v!.slice(0, 2)}:${v!.slice(2)}` };
    if (op === "m") {
      next.mode = v === "s" ? "schedule" : "interval";
      if (next.mode === "schedule") {
        next.schedule = w.schedule ?? { days: [], time: "08:00" };
        if (next.action === "auto") next.action = "offer";
      } else next.intervalMin = w.intervalMin ?? 15;
    }
    if (op === "a") next.action = v === "a" ? "auto" : v === "o" ? "offer" : "notify";
    try {
      if (op === "e") {
        next.enabled = !w.enabled;
        await setWatcherEnabled(env.DB, ctx.from.id, id, next.enabled, nextRunAt(next, nowSec(), true));
      } else if (op !== "r") {
        await editWatcher(env, ctx.from.id, id, next);
      }
      await ctx.answerCallbackQuery({ text: op === "a" && v === "a" ? "⚡ Буду записывать сам — в рамках лимитов ИТМО (2 в неделю)" : "Сохранено" });
      await ctx.editMessageText(watcherText({ ...next, id }), { parse_mode: "HTML", reply_markup: watcherKeyboard({ ...next, id }) }).catch(() => {});
    } catch (e) {
      await ctx.answerCallbackQuery({ text: itmoErrorText(e).slice(0, 190), show_alert: true });
    }
  });

  bot.callbackQuery(/^forget:(yes|no)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "no") return ctx.deleteMessage().catch(() => {});
    await deleteUser(env.DB, ctx.from.id);
    await ctx.editMessageText("Готово: токен, правила и история удалены.");
  });

  bot.callbackQuery(/^wm:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await setWatcherEnabled(env.DB, ctx.from.id, id, false, 0);
    await ctx.answerCallbackQuery({ text: "Правило выключено" });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  // Токен можно просто прислать сообщением — без команды.
  bot.on("message:text", async (ctx) => {
    if (looksLikeToken(ctx.message.text)) return handleToken(ctx, ctx.message.text);
    await ctx.reply("Не понял. /help — список команд, /guide — как подключить токен.");
  });

  bot.catch((err) => console.error("grammy", err.error));
  return bot;
}

/** Один раз на изоляте получаем getMe и дальше переиспользуем. */
export async function ensureBotInfo(bot: Bot) {
  if (!botInfo) {
    await bot.init();
    botInfo = bot.botInfo;
  }
}
