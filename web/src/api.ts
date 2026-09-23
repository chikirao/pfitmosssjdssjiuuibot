import type { Catch, CatchMode, Lesson, Me, MyResponse, ScheduleResponse, UserSettings, Watcher, WatcherInput } from "../../src/shared/types";
import { tg } from "./tg";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

// Локальная разработка вне Telegram: ?dev=<tg id> (сработает только если воркер в ENVIRONMENT=development)
const devUser = (() => {
  const q = new URLSearchParams(location.search).get("dev");
  try {
    if (q) localStorage.setItem("fizra:dev", q);
    return q || localStorage.getItem("fizra:dev");
  } catch {
    return q;
  }
})();

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (tg) headers.Authorization = `tma ${tg.initData}`;
  else if (devUser) headers["X-Dev-User"] = devUser;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError("Нет связи с сервером", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(data.error || `Ошибка ${res.status}`, res.status, data.code);
  return data as T;
}

export const api = {
  me: () => req<Me>("GET", "/me"),
  settings: (s: Partial<UserSettings>) => req<UserSettings>("PUT", "/settings", s),
  pause: (hours: number) => req<{ pausedUntil: number }>("POST", "/pause", { hours }),
  setToken: (text: string) => req<{ message: string; hasRefresh: boolean; token: Me["token"] }>("POST", "/token", { text }),
  deleteToken: () => req<{ ok: true }>("DELETE", "/token"),
  forget: () => req<{ ok: true }>("DELETE", "/me"),
  schedule: (from: string, to: string) => req<ScheduleResponse>("GET", `/schedule?from=${from}&to=${to}`),
  my: () => req<MyResponse>("GET", "/my"),
  sign: (lesson: Lesson) => req<{ ok: boolean; message: string; skipped?: boolean }>("POST", "/sign", { lesson }),
  unsign: (l: { id: number; section?: string; date?: string; start?: string }) => req<{ ok: boolean; message: string }>("POST", "/unsign", l),
  watchers: () => req<Watcher[]>("GET", "/watchers"),
  createWatcher: (w: WatcherInput) => req<Watcher>("POST", "/watchers", w),
  updateWatcher: (id: number, w: WatcherInput) => req<Watcher>("PUT", `/watchers/${id}`, w),
  toggleWatcher: (id: number) => req<Watcher>("POST", `/watchers/${id}/toggle`),
  deleteWatcher: (id: number) => req<{ ok: true }>("DELETE", `/watchers/${id}`),
  catches: () => req<Catch[]>("GET", "/catches"),
  createCatch: (lesson: Lesson, mode: CatchMode = "sign") => req<{ id: number }>("POST", "/catches", { lesson, mode }),
  cancelCatch: (id: number) => req<{ ok: true }>("DELETE", `/catches/${id}`),
};
