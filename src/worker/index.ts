import { webhookCallback } from "grammy";
import { Hono } from "hono";
import { api } from "./api";
import { appUrl, createBot, ensureBotInfo } from "./bot";
import { safeEqual } from "./crypto";
import type { Env } from "./env";
import { runScheduled } from "./scheduler";

const app = new Hono<{ Bindings: Env }>();

app.route("/api", api);

// Telegram webhook: принимаем только с правильным secret_token.
app.post("/tg/webhook", async (c) => {
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!c.env.WEBHOOK_SECRET || !safeEqual(secret, c.env.WEBHOOK_SECRET)) return c.text("forbidden", 403);
  const bot = createBot(c.env, new URL(c.req.url).origin);
  await ensureBotInfo(bot);
  return webhookCallback(bot, "hono")(c);
});

// Разовая настройка: webhook, команды, кнопка меню. Вызывать с ?key=WEBHOOK_SECRET.
app.get("/tg/setup", async (c) => {
  const key = c.req.query("key") ?? "";
  if (!c.env.WEBHOOK_SECRET || !safeEqual(key, c.env.WEBHOOK_SECRET)) return c.text("forbidden", 403);
  const origin = new URL(c.req.url).origin;
  const url = appUrl(c.env, origin);
  const bot = createBot(c.env, origin);
  await bot.api.setWebhook(`${origin}/tg/webhook`, {
    secret_token: c.env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  await bot.api.setMyCommands([
    { command: "free", description: "Свободные места" },
    { command: "my", description: "Мои записи" },
    { command: "watch", description: "Новое правило уведомлений" },
    { command: "watches", description: "Мои правила" },
    { command: "catches", description: "Ловушки мест" },
    { command: "token", description: "Токен ИТМО" },
    { command: "pause", description: "Тишина на N часов" },
    { command: "resume", description: "Вернуть уведомления" },
    { command: "settings", description: "Настройки" },
    { command: "help", description: "Помощь" },
  ]);
  await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Открыть", web_app: { url } } });
  return c.json({ ok: true, webhook: `${origin}/tg/webhook`, app: url });
});

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
