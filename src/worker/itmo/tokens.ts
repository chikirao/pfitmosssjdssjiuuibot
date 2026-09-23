// Токены ИТМО (Keycloak id.itmo.ru, client student-personal-cabinet).
// access живёт ~30 минут, refresh — пока жива SSO-сессия; воркер обновляет access сам.

export const ITMO_ISSUER = "https://id.itmo.ru/auth/realms/itmo";
export const TOKEN_ENDPOINT = `${ITMO_ISSUER}/protocol/openid-connect/token`;
export const CLIENT_ID = "student-personal-cabinet";

export interface JwtInfo {
  exp: number; // 0 = без срока (offline)
  typ: string;
  iss: string;
  sub: string;
}

export interface TokenPair {
  access: string;
  refresh: string | null;
  accessExp: number;
  refreshExp: number | null;
}

export class TokenInputError extends Error {}

function b64urlJson(part: string): Record<string, unknown> {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Разбор JWT без проверки подписи — подпись проверит сам my.itmo.ru; нам нужны exp/typ. */
export function decodeJwt(token: string): JwtInfo | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const c = b64urlJson(parts[1]!);
    return {
      exp: typeof c.exp === "number" ? c.exp : 0,
      typ: String(c.typ ?? ""),
      iss: String(c.iss ?? ""),
      sub: String(c.sub ?? ""),
    };
  } catch {
    return null;
  }
}

function clean(t: string): string {
  let s = t.trim().replace(/^["']|["']$/g, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* уже раскодирован */
  }
  return s.replace(/^bearer\s+/i, "").trim();
}

/**
 * Принимает то, что пользователь вставил: JSON от нашего скрипта {access, refresh},
 * JSON Keycloak {access_token, refresh_token}, две строки/через «|» или один access.
 */
export function parseTokenInput(input: string, nowSec: number): TokenPair {
  const text = input.trim();
  let candidates: string[] = [];
  if (text.startsWith("{")) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new TokenInputError("Не получилось разобрать JSON — скопируй вывод скрипта целиком");
    }
    candidates = [obj.access, obj.refresh, obj.access_token, obj.refresh_token].filter((x): x is string => typeof x === "string" && !!x && x !== "false");
    const rawRefresh = [obj.refresh, obj.refresh_token].find((x): x is string => typeof x === "string" && !!x && x !== "false");
    if (rawRefresh && !decodeJwt(clean(rawRefresh))) throw new TokenInputError("Refresh-токен повреждён при копировании — запусти скрипт ещё раз и вставь вывод целиком");
  } else {
    candidates = text.split(/[\s|;,]+/).filter(Boolean);
  }

  let access: string | null = null;
  let refresh: string | null = null;
  let accessInfo: JwtInfo | null = null;
  let refreshInfo: JwtInfo | null = null;
  for (const raw of candidates) {
    if (/^bearer$/i.test(raw)) continue;
    const tok = clean(raw);
    const info = decodeJwt(tok);
    if (!info) continue;
    if (info.iss !== ITMO_ISSUER) throw new TokenInputError("Это не токен ITMO ID");
    if (/^(refresh|offline)$/i.test(info.typ)) {
      refresh = tok;
      refreshInfo = info;
    } else {
      access = tok;
      accessInfo = info;
    }
  }
  if (!access && !refresh) throw new TokenInputError("Не нашёл токен. Скопируй вывод скрипта с my.itmo.ru целиком");
  if (refreshInfo && refreshInfo.exp && refreshInfo.exp <= nowSec) throw new TokenInputError("Refresh-токен уже истёк — обнови страницу my.itmo.ru и запусти скрипт ещё раз");
  if (!refresh && accessInfo && accessInfo.exp <= nowSec)
    throw new TokenInputError("В присланном нет refresh-токена, а access уже истёк. Обнови my.itmo.ru, запусти скрипт из /token и пришли вывод целиком");

  return {
    access: access ?? "",
    refresh,
    accessExp: accessInfo?.exp ?? 0,
    refreshExp: refreshInfo ? refreshInfo.exp : null,
  };
}

export class RefreshError extends Error {
  constructor(
    message: string,
    /** true — сессия ИТМО умерла, нужен новый токен от пользователя. */
    readonly fatal: boolean,
  ) {
    super(message);
  }
}

export async function refreshTokens(refresh: string): Promise<TokenPair> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refresh }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = String(body.error ?? res.status);
    // invalid_grant = сессия закрыта/истекла; остальное может быть временным
    throw new RefreshError(`ITMO ID: ${err}${body.error_description ? ` (${body.error_description})` : ""}`, err === "invalid_grant" || res.status === 400 || res.status === 401);
  }
  const access = String(body.access_token ?? "");
  const newRefresh = typeof body.refresh_token === "string" ? body.refresh_token : refresh;
  const aInfo = decodeJwt(access);
  const rInfo = decodeJwt(newRefresh);
  if (!aInfo) throw new RefreshError("ITMO ID вернул странный ответ", false);
  return { access, refresh: newRefresh, accessExp: aInfo.exp, refreshExp: rInfo ? rInfo.exp : null };
}
