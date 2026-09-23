export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  TOKEN_ENC_KEY: string;
  ALLOWED_USER_IDS: string;
  ENVIRONMENT?: string;
  SUBREQUEST_BUDGET?: string;
  /** Публичный URL мини-аппа (https://….workers.dev). Без него берём origin запроса. */
  APP_URL?: string;
  /** Только ENVIRONMENT=development: вход в мини-апп без Telegram под этим id. */
  DEV_USER_ID?: string;
  /** Только ENVIRONMENT=development: "1" — фейковый my.itmo.ru (src/worker/itmo/mock.ts). */
  MOCK_ITMO?: string;
}

export function allowedIds(env: Env): Set<number> {
  return new Set(
    (env.ALLOWED_USER_IDS || "")
      .split(/[,\s]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
  );
}

export function isAllowed(env: Env, id: number | undefined | null): id is number {
  return !!id && allowedIds(env).has(id);
}

export const isDev = (env: Env) => env.ENVIRONMENT === "development";
