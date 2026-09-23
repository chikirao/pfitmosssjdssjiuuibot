import { hmacSha256, safeEqual, toHex } from "../crypto";

export interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/** initData старше этого считаем протухшим (мини-апп перезапросит при переоткрытии). */
export const INIT_DATA_MAX_AGE_SEC = 24 * 3600;

/**
 * Проверка Telegram.WebApp.initData по официальной схеме:
 * secret = HMAC_SHA256("WebAppData", bot_token); hash = HMAC_SHA256(secret, data_check_string).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function verifyInitData(initData: string, botToken: string, nowSec: number): Promise<TgUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = await hmacSha256("WebAppData", botToken);
  const expected = toHex(await hmacSha256(secret, dataCheck));
  if (!safeEqual(expected, hash)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowSec - authDate > INIT_DATA_MAX_AGE_SEC || authDate - nowSec > 300) return null;

  try {
    const user = JSON.parse(params.get("user") || "null") as TgUser | null;
    return user && Number.isSafeInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}
