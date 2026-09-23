// HTTP-клиент my.itmo.ru с бюджетом subrequests и автообновлением access-токена.

export const ITMO_BASE = "https://my.itmo.ru";

export class ItmoError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Токен пользователя умер и обновить его нельзя — нужен новый от человека. */
export class TokenExpiredError extends ItmoError {
  constructor(message = "Токен ИТМО истёк — обнови его в профиле или через /token") {
    super(401, message);
  }
}

export class BudgetExceeded extends Error {
  constructor() {
    super("Исчерпан бюджет запросов на этот запуск");
  }
}

/** Лимит внешних fetch на один запуск воркера (у free-плана их 50). */
export class Budget {
  constructor(public remaining: number) {}
  take(n = 1) {
    if (this.remaining < n) throw new BudgetExceeded();
    this.remaining -= n;
  }
  has(n = 1) {
    return this.remaining >= n;
  }
}

export interface TokenProvider {
  /** Актуальный access-токен (обновит при необходимости). force — обновить принудительно. */
  getAccess(force?: boolean): Promise<string>;
}

const UA = "Mozilla/5.0 (compatible; fizra-bot/1.0; +personal use)";

export type MockHandler = (method: string, path: string, body: unknown) => Promise<unknown>;

export class ItmoClient {
  constructor(
    private tokens: TokenProvider,
    readonly budget: Budget,
    /** Только для локальной разработки: подменяет my.itmo.ru фейком. */
    private mock?: MockHandler,
  ) {}

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown) {
    return this.request<T>("POST", path, body);
  }
  del<T>(path: string, body?: unknown) {
    return this.request<T>("DELETE", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.tokens.getAccess(retried);
    this.budget.take();
    if (this.mock) return (await this.mock(method, path, body)) as T;
    const res = await fetch(ITMO_BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": UA,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) return this.request<T>(method, path, body, true);
    const text = await res.text();
    let data: { error_code?: number; error_message?: string; result?: unknown } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* не JSON */
    }
    if (res.status === 401) throw new TokenExpiredError();
    if (!res.ok || (data && typeof data.error_code === "number" && data.error_code !== 0)) {
      const msg = data?.error_message || `my.itmo.ru ответил ${res.status}`;
      throw new ItmoError(res.status, msg, data?.error_code);
    }
    return (data && "result" in data ? data.result : data) as T;
  }
}
