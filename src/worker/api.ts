import { Hono, type Context } from "hono";
import type { Lesson, Me, MyResponse } from "../shared/types";
import { verifyInitData } from "./auth/telegram";
import {
  cancelCatch,
  deleteUser,
  deleteWatcher,
  getUser,
  getWatcher,
  listCatches,
  listWatchers,
  parseSettings,
  recentSignups,
  saveSettings,
  setPaused,
  setWatcherEnabled,
  upsertUser,
} from "./db";
import { type Env, isAllowed, isDev } from "./env";
import { BudgetExceeded, ItmoError, TokenExpiredError } from "./itmo/client";
import { getAttempts, getChosen } from "./itmo/schedule";
import { clearTokens, itmoFor } from "./itmo/session";
import { nextRunAt, parseRange, sanitizeSettings, sanitizeWatcher, ValidationError } from "./rules";
import { acceptTokenInput, createCatch, createWatcher, editWatcher, loadSchedule, TokenInputError, tokenStatus } from "./services";
import { signUp, unsign } from "./signup";
import { nowSec } from "./time";

type Vars = { userId: number };
type C = Context<{ Bindings: Env; Variables: Vars }>;

export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

api.onError((e, c) => {
  if (e instanceof TokenExpiredError) return c.json({ error: e.message, code: "token" }, 401);
  if (e instanceof ValidationError || e instanceof TokenInputError) return c.json({ error: e.message }, 400);
  if (e instanceof ItmoError) return c.json({ error: e.message, code: "itmo" }, 502);
  if (e instanceof BudgetExceeded) return c.json({ error: "Слишком много запросов к ИТМО за раз — сузь фильтр" }, 429);
  console.error("api", e);
  return c.json({ error: "Внутренняя ошибка" }, 500);
});

// Авторизация: Telegram initData в заголовке. Вне вайтлиста — 403 на всё.
api.use("*", async (c, next) => {
  const auth = c.req.header("Authorization") ?? "";
  let id: number | null = null;
  let user: { id: number; first_name?: string; username?: string } | null = null;
  if (auth.startsWith("tma ")) {
    user = await verifyInitData(auth.slice(4), c.env.BOT_TOKEN, nowSec());
    id = user?.id ?? null;
  } else if (isDev(c.env) && c.env.DEV_USER_ID && c.req.header("X-Dev-User") === c.env.DEV_USER_ID) {
    id = Number(c.env.DEV_USER_ID);
    user = { id, first_name: "Dev" };
  }
  if (!id || !user) return c.json({ error: "Открой мини-апп из Telegram", code: "auth" }, 401);
  if (!isAllowed(c.env, id)) return c.json({ error: "Нет доступа", code: "forbidden" }, 403);
  await upsertUser(c.env.DB, user);
  c.set("userId", id);
  await next();
});

const uid = (c: C) => c.get("userId");
const body = async <T>(c: C): Promise<T> => {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new ValidationError("Ожидался JSON");
  }
};

function sanitizeLesson(raw: unknown): Lesson {
  const l = (raw ?? {}) as Partial<Lesson>;
  if (!Number.isSafeInteger(l.id) || typeof l.date !== "string" || !/^\d{4}-\d\d-\d\d$/.test(l.date) || typeof l.start !== "string" || !/^\d\d:\d\d$/.test(l.start)) {
    throw new ValidationError("Некорректное занятие");
  }
  const str = (v: unknown, n = 200) => (typeof v === "string" ? v.slice(0, n) : "");
  return {
    id: l.id!,
    key: str(l.key) || `${l.date}|${l.id}|${l.start}|${l.groupId ?? ""}`,
    groupId: Number.isSafeInteger(l.groupId) ? l.groupId! : null,
    buildingId: Number.isSafeInteger(l.buildingId) ? l.buildingId! : 0,
    buildingName: str(l.buildingName),
    date: l.date,
    start: l.start,
    end: typeof l.end === "string" && /^\d\d:\d\d$/.test(l.end) ? l.end : "",
    section: str(l.section) || "Занятие",
    sportTypeId: null,
    freeVisit: !!l.freeVisit,
    typeId: null,
    teacher: str(l.teacher),
    room: str(l.room),
    comment: "",
    available: Number(l.available) || 0,
    limit: Number(l.limit) || 0,
    canSign: !!l.canSign,
    intersection: !!l.intersection,
  };
}

// ---------- профиль ----------

api.get("/me", async (c) => {
  const row = await getUser(c.env.DB, uid(c));
  const me: Me = {
    id: uid(c),
    firstName: row?.first_name ?? null,
    username: row?.username ?? null,
    token: tokenStatus(row),
    settings: parseSettings(row?.settings),
    pausedUntil: row?.paused_until ?? 0,
  };
  return c.json(me);
});

api.put("/settings", async (c) => {
  const current = parseSettings((await getUser(c.env.DB, uid(c)))?.settings);
  const next = sanitizeSettings(await body(c), current);
  await saveSettings(c.env.DB, uid(c), next);
  return c.json(next);
});

api.post("/pause", async (c) => {
  const { hours } = await body<{ hours: number }>(c);
  const h = Math.min(24 * 14, Math.max(0, Number(hours) || 0));
  await setPaused(c.env.DB, uid(c), h ? nowSec() + h * 3600 : 0);
  return c.json({ pausedUntil: h ? nowSec() + h * 3600 : 0 });
});

api.post("/token", async (c) => {
  const { text } = await body<{ text: string }>(c);
  if (typeof text !== "string" || text.length > 20000) throw new ValidationError("Пустой токен");
  const r = await acceptTokenInput(c.env, uid(c), text);
  return c.json({ ...r, token: tokenStatus(await getUser(c.env.DB, uid(c))) });
});

api.delete("/token", async (c) => {
  await clearTokens(c.env, uid(c));
  return c.json({ ok: true });
});

api.delete("/me", async (c) => {
  await deleteUser(c.env.DB, uid(c));
  return c.json({ ok: true });
});

// ---------- расписание и запись ----------

api.get("/schedule", async (c) => {
  const buildings = (c.req.query("buildings") ?? "").split(",").map(Number).filter((n) => n > 0);
  const range = parseRange(c.req.query("from"), c.req.query("to"));
  if (typeof range === "string") return c.json({ error: range }, 400);
  const res = await loadSchedule(c.env, itmoFor(c.env, uid(c)), { buildings, ...range });
  return c.json(res);
});

api.get("/my", async (c) => {
  const client = itmoFor(c.env, uid(c));
  const [chosen, attempts, signups] = await Promise.all([getChosen(client), getAttempts(client), recentSignups(c.env.DB, uid(c))]);
  const res: MyResponse = {
    chosen,
    attempts,
    signups: signups.map((s) => ({ lessonId: s.lesson_id, section: s.section, date: s.date, start: s.start, source: s.source, action: s.action, ok: !!s.ok, message: s.message, createdAt: s.created_at })),
  };
  return c.json(res);
});

api.post("/sign", async (c) => {
  const { lesson } = await body<{ lesson: unknown }>(c);
  const l = sanitizeLesson(lesson);
  return c.json(await signUp(c.env, itmoFor(c.env, uid(c)), uid(c), l, "manual"));
});

api.post("/unsign", async (c) => {
  const b = await body<{ id: number; section?: string; date?: string; start?: string }>(c);
  if (!Number.isSafeInteger(b.id)) throw new ValidationError("Некорректное занятие");
  return c.json(await unsign(c.env, itmoFor(c.env, uid(c)), uid(c), { id: b.id, section: b.section, date: b.date, start: b.start }));
});

// ---------- правила ----------

api.get("/watchers", async (c) => c.json(await listWatchers(c.env.DB, uid(c))));

api.post("/watchers", async (c) => {
  const id = await createWatcher(c.env, uid(c), sanitizeWatcher(await body(c)));
  return c.json(await getWatcher(c.env.DB, uid(c), id));
});

api.put("/watchers/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!(await getWatcher(c.env.DB, uid(c), id))) return c.json({ error: "Не найдено" }, 404);
  await editWatcher(c.env, uid(c), id, sanitizeWatcher(await body(c)));
  return c.json(await getWatcher(c.env.DB, uid(c), id));
});

api.post("/watchers/:id/toggle", async (c) => {
  const id = Number(c.req.param("id"));
  const w = await getWatcher(c.env.DB, uid(c), id);
  if (!w) return c.json({ error: "Не найдено" }, 404);
  const enabled = !w.enabled;
  await setWatcherEnabled(c.env.DB, uid(c), id, enabled, nextRunAt({ ...w, enabled }, nowSec(), true));
  return c.json(await getWatcher(c.env.DB, uid(c), id));
});

api.delete("/watchers/:id", async (c) => {
  await deleteWatcher(c.env.DB, uid(c), Number(c.req.param("id")));
  return c.json({ ok: true });
});

// ---------- «поймать место» ----------

api.get("/catches", async (c) => c.json(await listCatches(c.env.DB, uid(c))));

api.post("/catches", async (c) => {
  const { lesson } = await body<{ lesson: unknown }>(c);
  const id = await createCatch(c.env, uid(c), sanitizeLesson(lesson));
  return c.json({ id });
});

api.delete("/catches/:id", async (c) => {
  await cancelCatch(c.env.DB, uid(c), Number(c.req.param("id")));
  return c.json({ ok: true });
});
