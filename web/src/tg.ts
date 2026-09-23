// Тонкая обёртка над Telegram.WebApp — вне Telegram всё просто no-op.
interface TgWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  setHeaderColor(c: string): void;
  setBackgroundColor(c: string): void;
  onEvent(e: string, cb: () => void): void;
  openLink(url: string): void;
  showConfirm(msg: string, cb: (ok: boolean) => void): void;
  HapticFeedback?: { impactOccurred(s: string): void; notificationOccurred(s: string): void; selectionChanged(): void };
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  isVersionAtLeast?(v: string): boolean;
  disableVerticalSwipes?(): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export const tg: TgWebApp | null = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;

export function initTelegram(onTheme: (dark: boolean) => void) {
  const mq = matchMedia("(prefers-color-scheme: dark)");
  if (!tg) {
    onTheme(mq.matches);
    mq.addEventListener("change", () => onTheme(mq.matches));
    return;
  }
  const app = tg;
  app.ready();
  app.expand();
  try {
    app.disableVerticalSwipes?.();
  } catch {
    /* старые клиенты */
  }
  const apply = () => {
    const dark = app.colorScheme === "dark";
    onTheme(dark);
    const bg = dark ? "#0e0e10" : "#f3f3f3";
    try {
      app.setHeaderColor(bg);
      app.setBackgroundColor(bg);
    } catch {
      /* ignore */
    }
  };
  apply();
  app.onEvent("themeChanged", apply);
}

export const haptic = {
  tap: () => tg?.HapticFeedback?.selectionChanged(),
  ok: () => tg?.HapticFeedback?.notificationOccurred("success"),
  err: () => tg?.HapticFeedback?.notificationOccurred("error"),
  press: () => tg?.HapticFeedback?.impactOccurred("light"),
};

export function confirmDialog(msg: string): Promise<boolean> {
  const app = tg;
  if (app?.isVersionAtLeast?.("6.2")) return new Promise((r) => app.showConfirm(msg, r));
  return Promise.resolve(window.confirm(msg));
}

export function openLink(url: string) {
  if (tg) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

let backHandler: (() => void) | null = null;
export function setBack(cb: (() => void) | null) {
  const bb = tg?.BackButton;
  if (!bb) return;
  if (backHandler) bb.offClick(backHandler);
  backHandler = cb;
  if (cb) {
    bb.onClick(cb);
    bb.show();
  } else bb.hide();
}
