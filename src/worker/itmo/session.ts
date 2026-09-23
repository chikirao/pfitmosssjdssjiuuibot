// Хранение токенов пользователя (зашифровано) и выдача ItmoClient с автообновлением.
import { decryptString, encryptString } from "../crypto";
import { getUser, type UserRow } from "../db";
import type { Env } from "../env";
import { nowSec } from "../time";
import { Budget, ItmoClient, ItmoError, TokenExpiredError, type TokenProvider } from "./client";
import { RefreshError, refreshTokens, type TokenPair } from "./tokens";

/** Обновляем access заранее, если ему осталось меньше этого. */
const REFRESH_MARGIN_SEC = 5 * 60;
const LOCK_SEC = 20;

const aad = (id: number, kind: "access" | "refresh") => `tg:${id}:${kind}`;

export async function storeTokens(env: Env, tgId: number, t: TokenPair) {
  const now = nowSec();
  const accessEnc = t.access ? await encryptString(env.TOKEN_ENC_KEY, t.access, aad(tgId, "access")) : null;
  const refreshEnc = t.refresh ? await encryptString(env.TOKEN_ENC_KEY, t.refresh, aad(tgId, "refresh")) : null;
  await env.DB.prepare(
    `UPDATE users SET access_enc = ?, access_exp = ?, refresh_enc = COALESCE(?, refresh_enc), refresh_exp = COALESCE(?, refresh_exp),
       token_status = 'ok', token_alerted = 0, refresh_lock_until = 0, updated_at = ? WHERE tg_id = ?`,
  )
    .bind(accessEnc, t.accessExp || null, refreshEnc, t.refresh ? (t.refreshExp ?? 0) : null, now, tgId)
    .run();
}

/** Новый токен от пользователя полностью заменяет старый (включая refresh). */
export async function replaceTokens(env: Env, tgId: number, t: TokenPair) {
  await env.DB.prepare("UPDATE users SET refresh_enc = NULL, refresh_exp = NULL WHERE tg_id = ?").bind(tgId).run();
  await storeTokens(env, tgId, t);
}

export async function clearTokens(env: Env, tgId: number) {
  await env.DB.prepare(
    "UPDATE users SET access_enc = NULL, access_exp = NULL, refresh_enc = NULL, refresh_exp = NULL, token_status = 'none', token_alerted = 0, updated_at = ? WHERE tg_id = ?",
  )
    .bind(nowSec(), tgId)
    .run();
}

export async function markExpired(env: Env, tgId: number) {
  await env.DB.prepare("UPDATE users SET token_status = 'expired', refresh_lock_until = 0, updated_at = ? WHERE tg_id = ?").bind(nowSec(), tgId).run();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DbTokenProvider implements TokenProvider {
  private cached: { token: string; exp: number } | null = null;

  constructor(
    private env: Env,
    private tgId: number,
    private budget: Budget,
  ) {}

  async getAccess(force = false): Promise<string> {
    const now = nowSec();
    if (!force && this.cached && this.cached.exp - now > 60) return this.cached.token;

    let row = await getUser(this.env.DB, this.tgId);
    if (!row || row.token_status === "none") throw new TokenExpiredError("Сначала добавь токен ИТМО: /token или «Профиль» в мини-аппе");
    if (row.token_status === "expired") throw new TokenExpiredError();

    if (!force && row.access_enc && (row.access_exp ?? 0) - now > REFRESH_MARGIN_SEC) return this.remember(row);
    if (!row.refresh_enc) {
      if (!force && row.access_enc && (row.access_exp ?? 0) > now) return this.remember(row);
      await markExpired(this.env, this.tgId);
      throw new TokenExpiredError();
    }

    // Лиза: только один воркер одновременно обменивает refresh (Keycloak может ротировать refresh-токены).
    const lock = await this.env.DB.prepare("UPDATE users SET refresh_lock_until = ? WHERE tg_id = ? AND refresh_lock_until < ?")
      .bind(now + LOCK_SEC, this.tgId, now)
      .run();
    if (!lock.meta.changes) {
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        row = await getUser(this.env.DB, this.tgId);
        if (row?.access_enc && (row.access_exp ?? 0) - nowSec() > REFRESH_MARGIN_SEC) return this.remember(row);
        if (row?.token_status === "expired") throw new TokenExpiredError();
      }
      if (row?.access_enc && (row.access_exp ?? 0) > nowSec()) return this.remember(row);
      throw new ItmoError(503, "Токен сейчас обновляется, попробуй через пару секунд");
    }

    try {
      const refresh = await decryptString(this.env.TOKEN_ENC_KEY, row.refresh_enc, aad(this.tgId, "refresh"));
      this.budget.take();
      const pair = await refreshTokens(refresh);
      await storeTokens(this.env, this.tgId, pair);
      this.cached = { token: pair.access, exp: pair.accessExp };
      return pair.access;
    } catch (e) {
      if (e instanceof RefreshError && e.fatal) {
        await markExpired(this.env, this.tgId);
        throw new TokenExpiredError();
      }
      await this.env.DB.prepare("UPDATE users SET refresh_lock_until = 0 WHERE tg_id = ?").bind(this.tgId).run();
      if (row.access_enc && (row.access_exp ?? 0) > nowSec() && !force) return this.remember(row);
      throw e instanceof Error ? new ItmoError(503, `Не удалось обновить токен: ${e.message}`) : e;
    }
  }

  private async remember(row: UserRow): Promise<string> {
    const token = await decryptString(this.env.TOKEN_ENC_KEY, row.access_enc!, aad(this.tgId, "access"));
    this.cached = { token, exp: row.access_exp ?? 0 };
    return token;
  }
}

const useMock = (env: Env) => env.ENVIRONMENT === "development" && env.MOCK_ITMO === "1";

export function itmoFor(env: Env, tgId: number, budget = new Budget(Number(env.SUBREQUEST_BUDGET) || 40)) {
  if (useMock(env)) {
    // в моке токен всё равно должен быть «подключён», но не обновляется
    const provider: TokenProvider = { getAccess: async () => "mock" };
    return new ItmoClient(provider, budget, (m, p, b) => import("./mock").then((x) => x.mockRequest(m, p, b)));
  }
  return new ItmoClient(new DbTokenProvider(env, tgId, budget), budget);
}

/** Для cron: обновить токен заранее, чтобы SSO-сессия ИТМО не засыпала. */
export async function keepAlive(env: Env, row: UserRow, budget: Budget) {
  if (useMock(env)) return false;
  const now = nowSec();
  if ((row.access_exp ?? 0) - now > REFRESH_MARGIN_SEC) return false;
  await new DbTokenProvider(env, row.tg_id, budget).getAccess();
  return true;
}
