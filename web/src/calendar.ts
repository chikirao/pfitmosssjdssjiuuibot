// Всплывающий календарь для выбора диапазона дат расписания.
// Первое нажатие — начало, второе — конец; одиночный день — нажать и «Показать».
import { LIMITS } from "../../src/shared/types";
import { haptic } from "./tg";
import { $, $$, asDate, closePopover, fluidHover, fmtShort, openPopover, plural, popoverOpenOn, TODAY, WD, ymd } from "./ui";

export type RangePreset = "today" | "tomorrow" | "week" | "next" | "2w" | "month";
export type RangePick = { preset: RangePreset } | { from: string; to: string };
export interface Range {
  from: string;
  to: string;
}

export const PRESETS: [RangePreset, string][] = [
  ["today", "Сегодня"],
  ["tomorrow", "Завтра"],
  ["week", "Эта неделя"],
  ["next", "След. неделя"],
  ["2w", "2 недели"],
  ["month", "Месяц"],
];

export const addDays = (d: string, n: number) => {
  const x = asDate(d);
  x.setDate(x.getDate() + n);
  return ymd(x);
};
const isoWd = (d: string) => ((asDate(d).getDay() + 6) % 7) + 1;
export const daysBetween = (a: string, b: string) => Math.round((asDate(b).getTime() - asDate(a).getTime()) / 86400000);

export function resolveRange(p: RangePick, t = TODAY()): Range {
  if ("from" in p) {
    if (p.to < t) return resolveRange({ preset: "2w" }, t);
    return { from: p.from < t ? t : p.from, to: p.to };
  }
  const mon = addDays(t, 1 - isoWd(t));
  switch (p.preset) {
    case "today":
      return { from: t, to: t };
    case "tomorrow":
      return { from: addDays(t, 1), to: addDays(t, 1) };
    case "week":
      return { from: t, to: addDays(mon, 6) };
    case "next":
      return { from: addDays(mon, 7), to: addDays(mon, 13) };
    case "month":
      return { from: t, to: addDays(t, 29) };
    default:
      return { from: t, to: addDays(t, 13) };
  }
}

const short = (d: string) => fmtShort.format(asDate(d)).replace(".", "");

export function rangeLabel(p: RangePick, r = resolveRange(p)): string {
  if ("preset" in p) return PRESETS.find(([k]) => k === p.preset)![1];
  if (r.from === r.to) return `${short(r.from)}, ${WD[isoWd(r.from)]}`;
  if (r.from.slice(0, 7) === r.to.slice(0, 7)) return `${+r.from.slice(8)}–${short(r.to)}`;
  return `${short(r.from)} – ${short(r.to)}`;
}

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const CHEV = (d: string) => `<svg class="i" viewBox="0 0 24 24"><path d="${d}"/></svg>`;

/**
 * Открыть календарь у кнопки. `marks` — дни, где в уже загруженном расписании есть свободные места (точка под числом).
 */
export function openCalendar(anchor: HTMLElement, current: RangePick, onPick: (p: RangePick) => void, marks: Record<string, number> = {}) {
  if (popoverOpenOn(anchor)) return closePopover();
  haptic.press();
  const today = TODAY();
  const max = addDays(today, LIMITS.maxAheadDays);
  const cur = resolveRange(current);
  let a = cur.from;
  let b = cur.to;
  let picking = false;
  let hover: string | null = null;
  let month = cur.from.slice(0, 8) + "01";
  const presetNow = "preset" in current ? current.preset : null;

  const html = `<div class="cal">
    <div class="cal-presets">${PRESETS.map(([k, t]) => `<button class="chip" data-preset="${k}" aria-pressed="${k === presetNow}">${t}</button>`).join("")}</div>
    <div class="cal-head">
      <button class="icon-btn" data-nav="-1" aria-label="Предыдущий месяц">${CHEV("m15 6-6 6 6 6")}</button>
      <div class="cal-title" aria-live="polite"></div>
      <button class="icon-btn" data-nav="1" aria-label="Следующий месяц">${CHEV("m9 6 6 6-6 6")}</button>
    </div>
    <div class="cal-wd">${WD.slice(1)
      .map((d, i) => `<span class="${i > 4 ? "we" : ""}">${d}</span>`)
      .join("")}</div>
    <div class="cal-body"><div class="cal-grid" role="grid"></div></div>
    <div class="cal-foot"><div class="cal-sum"></div><button class="btn btn-primary" id="calOk"><span>Показать</span></button></div>
  </div>`;

  openPopover(
    anchor,
    html,
    (el) => {
      const grid = () => $(".cal-grid", el);
      const far = (d: string) => picking && Math.abs(daysBetween(a, d)) >= LIMITS.maxRangeDays;

      const renderMonth = (dir = 0) => {
        const first = month;
        // прошедшие недели текущего месяца не показываем — календарь ниже и сразу про нужное
        const from = first < today ? today : first;
        const start = addDays(from, 1 - isoWd(from));
        const nm = asDate(first); // 1-е следующего месяца (Date сам переносит декабрь → январь)
        nm.setMonth(nm.getMonth() + 1);
        const last = addDays(ymd(nm), -1);
        const cells: string[] = [];
        for (let i = 0, d = start; d <= last || i % 7 !== 0; i++, d = addDays(d, 1)) {
          const out = d.slice(0, 7) !== first.slice(0, 7);
          const off = d < today || d > max;
          cells.push(
            `<button class="cal-d ${out ? "out" : ""} ${d === today ? "today" : ""} ${i % 7 === 0 ? "row-s" : ""} ${i % 7 === 6 ? "row-e" : ""}" data-d="${d}" ${off ? "disabled" : ""} aria-label="${d}"><span>${+d.slice(8)}</span>${marks[d] ? `<i class="dot"></i>` : ""}</button>`,
          );
        }
        const g = grid();
        g.innerHTML = cells.join("");
        g.classList.remove("from-l", "from-r");
        if (dir) {
          void g.offsetWidth; // перезапуск анимации
          g.classList.add(dir > 0 ? "from-r" : "from-l");
        }
        const [y, m] = first.split("-").map(Number);
        $(".cal-title", el).innerHTML = `<span class="${dir ? (dir > 0 ? "from-r" : "from-l") : ""}">${MONTHS[m! - 1]} <i>${y}</i></span>`;
        $<HTMLButtonElement>('[data-nav="-1"]', el).disabled = first <= today.slice(0, 8) + "01";
        $<HTMLButtonElement>('[data-nav="1"]', el).disabled = ymd(nm) > max;
        paint();
      };

      const paint = () => {
        const lo0 = a;
        const hi0 = picking ? (hover ?? a) : b;
        const [lo, hi] = lo0 <= hi0 ? [lo0, hi0] : [hi0, lo0];
        for (const c of $$<HTMLButtonElement>(".cal-d", grid())) {
          const d = c.dataset.d!;
          const inR = d >= lo && d <= hi;
          c.classList.toggle("in", inR);
          c.classList.toggle("s", d === lo);
          c.classList.toggle("e", d === hi);
          c.classList.toggle("pv", picking && inR);
          c.classList.toggle("far", far(d));
          c.setAttribute("aria-selected", String(inR));
        }
        const n = daysBetween(lo, hi) + 1;
        $(".cal-sum", el).innerHTML = picking
          ? `<b>${short(a)}</b> — теперь конец диапазона<br><span class="muted">или «Показать» для одного дня</span>`
          : `<b>${rangeLabel({ from: lo, to: hi })}</b><br><span class="muted">${n} ${plural(n, "день", "дня", "дней")}</span>`;
      };

      renderMonth();

      el.addEventListener("click", (e) => {
        const t = e.target as HTMLElement;
        const nav = t.closest<HTMLButtonElement>("[data-nav]");
        if (nav) {
          const d = asDate(month);
          d.setMonth(d.getMonth() + Number(nav.dataset.nav));
          month = ymd(d);
          haptic.tap();
          return renderMonth(Number(nav.dataset.nav));
        }
        const pr = t.closest<HTMLButtonElement>("[data-preset]");
        if (pr) {
          haptic.tap();
          closePopover();
          return onPick({ preset: pr.dataset.preset as RangePreset });
        }
        if (t.closest("#calOk")) {
          const [lo, hi] = picking ? [a, a] : [a, b];
          closePopover();
          return onPick({ from: lo, to: hi });
        }
        const c = t.closest<HTMLButtonElement>(".cal-d");
        if (!c || c.disabled || c.classList.contains("far")) return;
        const d = c.dataset.d!;
        haptic.tap();
        $$(".cal-presets .chip", el).forEach((x) => x.setAttribute("aria-pressed", "false"));
        if (!picking) {
          a = b = d;
          picking = true;
          hover = null;
        } else {
          [a, b] = d < a ? [d, a] : [a, d];
          picking = false;
        }
        paint();
      });
      // превью диапазона под курсором, пока выбираешь конец
      el.addEventListener("pointerover", (e) => {
        if (!picking) return;
        const c = (e.target as HTMLElement).closest<HTMLButtonElement>(".cal-d");
        const d = c && !c.disabled && !c.classList.contains("far") ? c.dataset.d! : null;
        if (d !== hover) {
          hover = d;
          paint();
        }
      });
      fluidHover($(".cal-body", el), ".cal-d:not(:disabled):not(.far) > span");
    },
    { className: "pop-cal", needHeight: 470 },
  );
}
