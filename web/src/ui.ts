import { haptic, setBack } from "./tg";

export const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
export const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll(s)] as T[];

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);
export const icon = (id: string) => `<svg class="i"><use href="#i-${id}"/></svg>`;
export const SPIN = `<span class="spin"><svg viewBox="0 0 24 24" fill="none"><path d="M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z" stroke="currentColor" stroke-width="1.125" stroke-linecap="round" pathLength="100"/></svg></span>`;

export const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
};

const pad = (n: number) => String(n).padStart(2, "0");
/** «Настенное» московское время (расписание ИТМО — МСК). */
export const mskNow = () => new Date(Date.now() + (new Date().getTimezoneOffset() + 180) * 60000);
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const TODAY = () => ymd(mskNow());
export const nowHHMM = () => {
  const d = mskNow();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const asDate = (s: string) => new Date(s + "T12:00:00");
export const fmtDay = new Intl.DateTimeFormat("ru", { weekday: "long", day: "numeric", month: "long" });
export const fmtShort = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" });
export const fmtWd = new Intl.DateTimeFormat("ru", { weekday: "short" });
export const WD = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];

export function fmtUnix(sec: number) {
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }).format(sec * 1000);
}

export function ago(t: string | number) {
  const ms = typeof t === "number" ? t * 1000 : new Date(t).getTime();
  const s = (Date.now() - ms) / 1000;
  const rtf = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
  if (Math.abs(s) < 60) return "только что";
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (Math.abs(s) < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
}

export function toast(msg: string, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.innerHTML = icon(bad ? "x" : "check") + `<span>${esc(msg)}</span>`;
  $("#toasts").append(el);
  (bad ? haptic.err : haptic.ok)();
  setTimeout(
    () => {
      el.classList.add("out");
      el.addEventListener("animationend", () => el.remove());
    },
    bad ? 4800 : 2400,
  );
}

export function countUp(el: HTMLElement, to: number) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = String(to);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) {
    el.textContent = String(to);
    return;
  }
  const t0 = performance.now();
  const tick = (t: number) => {
    const p = Math.min(1, (t - t0) / 600);
    el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 4))));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Сегмент/док со скользящим индикатором. */
export function moveInd(container: Element | null) {
  const on = container?.querySelector<HTMLElement>('[aria-selected="true"]');
  const ind = container?.querySelector<HTMLElement>(".ind");
  if (!on || !ind) return;
  ind.style.setProperty("--w", on.offsetWidth + "px");
  ind.style.setProperty("--x", on.offsetLeft + "px");
}

/** Кнопка с состоянием загрузки на время промиса; ошибки показываются тостом. */
export async function withLoading<T>(btn: HTMLButtonElement | null | undefined, fn: () => Promise<T>): Promise<T | undefined> {
  if (btn) {
    if (!btn.querySelector(".spin")) btn.insertAdjacentHTML("beforeend", SPIN);
    btn.classList.add("loading");
    btn.disabled = true;
  }
  try {
    return await fn();
  } catch (e) {
    toast((e as Error).message, true);
    return undefined;
  } finally {
    if (btn) {
      btn.classList.remove("loading");
      btn.disabled = false;
    }
  }
}

// ---------- bottom sheet ----------
const sheet = () => $<HTMLDialogElement>("#sheet");

export function openSheet(html: string, onMount?: (body: HTMLElement) => void) {
  const d = sheet();
  const body = $("#sheetBody");
  body.innerHTML = html;
  if (!d.open) d.showModal();
  d.scrollTop = 0;
  setBack(closeSheet);
  onMount?.(body);
  return body;
}

export function closeSheet() {
  const d = sheet();
  if (d.open) d.close();
}

export function initSheet() {
  const d = sheet();
  d.addEventListener("click", (e) => {
    if (e.target === d) closeSheet();
  });
  d.addEventListener("close", () => setBack(null));
}

export const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem("fizra:" + k);
      return v == null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem("fizra:" + k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // запасной путь для WebView без Clipboard API
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
