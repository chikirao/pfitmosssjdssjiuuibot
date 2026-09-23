import type { Lesson } from "../../../src/shared/types";
import { api, ApiError } from "../api";
import { emit, hasToken, on, state } from "../state";
import { openCalendar, rangeLabel, resolveRange, type RangePick } from "../calendar";
import { haptic } from "../tg";
import {
  $,
  $$,
  asDate,
  closePopover,
  closeSheet,
  fluidHover,
  openPopover,
  popoverOpenOn,
  countUp,
  debounce,
  esc,
  fmtDay,
  fmtShort,
  fmtWd,
  icon,
  moveInd,
  openSheet,
  plural,
  store,
  toast,
  TODAY,
  nowHHMM,
  withLoading,
  ymd,
} from "../ui";
import { openWatcherEditor } from "./alerts";
import { openTokenSheet } from "./token";

const f = {
  view: store.get<"days" | "sections">("view", "days"),
  building: store.get<string>("building", "all"),
  range: store.get<RangePick>("range", { preset: "2w" }),
  q: "",
  onlyFree: store.get("onlyFree", true),
  onlyCan: store.get("onlyCan", false),
  noIntersect: store.get("noIntersect", false),
  noFreeVisit: store.get("noFreeVisit", false),
  showPast: false,
  sections: new Set<string>(),
};
type BoolKey = "onlyFree" | "onlyCan" | "noIntersect" | "noFreeVisit" | "showPast";

const PAGE = 40; // карточек за раз — держим DOM лёгким на телефоне
let pageLimit = PAGE;
let loading = false;

const root = () => $("#view-schedule");
const inBuilding = (l: Lesson) => f.building === "all" || String(l.buildingId) === f.building;
const notPast = (l: Lesson) => f.showPast || l.date > TODAY() || (l.date === TODAY() && l.end >= nowHHMM());

function filtered(ignoreSections = false) {
  const q = f.q.trim().toLowerCase();
  return (state.schedule?.lessons ?? []).filter(
    (l) =>
      inBuilding(l) &&
      notPast(l) &&
      (!f.onlyFree || l.available > 0) &&
      (!f.onlyCan || l.canSign) &&
      (!f.noFreeVisit || !l.freeVisit) &&
      (!f.noIntersect || !l.intersection) &&
      (ignoreSections || !f.sections.size || f.sections.has(l.section)) &&
      (!q || `${l.section} ${l.teacher} ${l.room} ${l.comment}`.toLowerCase().includes(q)),
  );
}

// ---------- загрузка ----------

export async function loadSchedule(force = false) {
  if (!hasToken() || loading) return;
  const r = resolveRange(f.range);
  const cached = store.get<typeof state.schedule>("schedule", null);
  if (!force && !state.schedule && cached && cached.dateStart === r.from && cached.dateEnd === r.to) {
    state.schedule = cached; // мгновенно показываем прошлые данные, потом обновляем
    emit("schedule");
  }
  loading = true;
  $("#reload")?.classList.add("spinning");
  $("#list")?.classList.add("stale");
  try {
    state.schedule = await api.schedule(r.from, r.to);
    state.scheduleError = null;
    store.set("schedule", state.schedule);
  } catch (e) {
    state.scheduleError = (e as Error).message;
    if (e instanceof ApiError && e.code === "token" && state.me) state.me.token.status = "expired";
    if (!state.schedule) emit("schedule");
    else toast((e as Error).message, true);
  } finally {
    loading = false;
    $("#reload")?.classList.remove("spinning");
    $("#list")?.classList.remove("stale");
  }
  emit("schedule");
}

// ---------- рендер ----------

export function renderSchedule() {
  const el = root();
  if (!state.me) {
    el.innerHTML = `<div class="skeleton" style="margin-top:8px"></div>`;
    return;
  }
  if (!hasToken()) {
    delete el.dataset.shell;
    const expired = state.me.token.status === "expired";
    el.innerHTML = `
      <div class="card empty enter">
        <svg viewBox="0 0 120 80" width="120" height="80" aria-hidden="true">
          <path d="M14 70a46 46 0 0 1 92 0" fill="none" stroke="var(--line)" stroke-width="7" stroke-linecap="round" stroke-dasharray="7 9"/>
          <path d="M14 70a46 46 0 0 1 60-43.8" fill="none" stroke="var(--accent)" stroke-width="7" stroke-linecap="round"/>
          <circle cx="60" cy="62" r="7" fill="var(--ok)"/>
        </svg>
        <h2>${expired ? "Сессия ИТМО закончилась" : "Подключи my.itmo.ru"}</h2>
        <p>${expired ? "Токен больше не обновляется — добавь новый, и всё заработает." : "Нужен токен твоего аккаунта ИТМО — тогда я покажу свободные места и смогу записывать на занятия."}</p>
        <button class="soft lg" id="connect">${icon("key")} ${expired ? "Обновить токен" : "Подключить"}</button>
      </div>`;
    $<HTMLButtonElement>("#connect", el).onclick = () => openTokenSheet(() => loadSchedule(true));
    return;
  }
  if (!state.schedule) {
    el.innerHTML = state.scheduleError
      ? `<div class="card empty"><h2>Не получилось загрузить</h2><p>${esc(state.scheduleError)}</p><button class="soft" id="retry">${icon("refresh")} Ещё раз</button></div>`
      : `<div class="stats"><div class="skeleton chart-card" style="height:260px"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>`;
    $<HTMLButtonElement>("#retry", el)?.addEventListener("click", () => loadSchedule(true));
    return;
  }
  renderShell();
  renderStats();
  renderList();
}

function renderShell() {
  const el = root();
  if (el.dataset.shell) return;
  el.dataset.shell = "1";
  el.innerHTML = `
    <section class="stats">
      <div class="card chart-card enter">
        <div class="card-head">${icon("chart")} Свободные места по дням <span class="right" id="chartRange"></span></div>
        <div class="chart-scroll" id="chartScroll"><div class="chart" id="chart"></div></div>
        <div class="chart-summary" id="chartSummary"></div>
      </div>
      <div class="card enter" style="--i:1"><div class="card-head">${icon("seat")} Свободно</div><div class="big"><span id="sFree">0</span><small>занятий</small></div><div class="hint" id="sFreeHint"></div></div>
      <div class="card enter" style="--i:2"><div class="card-head">${icon("layers")} Секции</div><div class="big"><span id="sSec">0</span><small id="sSecOf"></small></div><div class="hint">с местами</div></div>
      <div class="card enter" style="--i:3"><div class="card-head">${icon("user")} Мест всего</div><div class="big"><span id="sSeats">0</span></div><div class="hint" id="sSeatsHint"></div></div>
      <div class="card enter" style="--i:4"><div class="card-head">${icon("check")} Можно записаться</div><div class="big"><span id="sCan">0</span><small>занятий</small></div><div class="hint">прямо сейчас</div></div>
    </section>
    <div class="toolbar">
      <label class="search">${icon("search")}<input id="q" type="search" placeholder="Секция, преподаватель, зал…" autocomplete="off" enterkeyhint="search"></label>
      <div class="tb-row">
        <button class="ctl" id="range" aria-haspopup="dialog" aria-expanded="false">${icon("cal")}<span id="rangeLbl">${esc(rangeLabel(f.range))}</span>${CHEVRON}</button>
        <button class="ctl" id="building" aria-haspopup="listbox" aria-expanded="false">${icon("pin")}<span id="buildingLbl">Все корпуса</span>${CHEVRON}</button>
      </div>
      <div class="viewseg" id="viewSeg" role="tablist"><span class="ind"></span>
        <button role="tab" data-view="days" aria-selected="${f.view === "days"}" aria-label="По дням">${icon("list")}<span class="lbl">Дни</span></button>
        <button role="tab" data-view="sections" aria-selected="${f.view === "sections"}" aria-label="По секциям">${icon("layers")}<span class="lbl">Секции</span></button>
      </div>
    </div>
    <div class="pills" id="pills"></div>
    <div class="chips" id="chips"></div>
    <div id="list"></div>`;

  const q = $<HTMLInputElement>("#q", el);
  q.addEventListener(
    "input",
    debounce(() => {
      f.q = q.value;
      pageLimit = PAGE;
      renderList();
    }, 150),
  );
  $<HTMLButtonElement>("#building", el).onclick = (e) => openBuildingMenu(e.currentTarget as HTMLButtonElement);
  $<HTMLButtonElement>("#range", el).onclick = (e) => {
    const s = state.schedule;
    const marks: Record<string, number> = {};
    for (const l of s?.lessons ?? []) if (inBuilding(l) && l.available > 0) marks[l.date] = (marks[l.date] ?? 0) + 1;
    openCalendar(
      e.currentTarget as HTMLButtonElement,
      f.range,
      (p) => {
        f.range = p;
        store.set("range", p);
        $("#rangeLbl").textContent = rangeLabel(p);
        pageLimit = PAGE;
        loadSchedule(true);
      },
      marks,
    );
  };
  const seg = $("#viewSeg", el);
  $$<HTMLButtonElement>("button", seg).forEach(
    (b) =>
      (b.onclick = () => {
        f.view = b.dataset.view as typeof f.view;
        store.set("view", f.view);
        $$("button", seg).forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        moveInd(seg);
        haptic.tap();
        pageLimit = PAGE;
        renderList();
      }),
  );
  requestAnimationFrame(() => moveInd(seg));

  const pills: [BoolKey, string][] = [
    ["onlyFree", "Есть места"],
    ["onlyCan", "Можно записаться"],
    ["noIntersect", "Без пересечений с парами"],
    ["noFreeVisit", "Без свободного посещения"],
    ["showPast", "Прошедшие"],
  ];
  const pillsEl = $("#pills", el);
  pillsEl.innerHTML = pills.map(([k, t]) => `<button class="pill" data-k="${k}" aria-pressed="${f[k]}"><span class="dot"></span>${t}</button>`).join("");
  $$<HTMLButtonElement>(".pill", pillsEl).forEach(
    (p) =>
      (p.onclick = () => {
        const k = p.dataset.k as BoolKey;
        f[k] = !f[k];
        if (k !== "showPast") store.set(k, f[k]);
        p.setAttribute("aria-pressed", String(f[k]));
        haptic.tap();
        pageLimit = PAGE;
        if (k === "showPast") renderStats();
        renderList();
      }),
  );

  $("#chips", el).addEventListener("click", (e) => {
    const c = (e.target as HTMLElement).closest<HTMLButtonElement>(".chip");
    if (!c) return;
    if (c.dataset.reset !== undefined) f.sections.clear();
    else {
      const n = c.dataset.name!;
      f.sections.has(n) ? f.sections.delete(n) : f.sections.add(n);
    }
    haptic.tap();
    pageLimit = PAGE;
    renderList();
  });

  // делегирование кликов по карточкам — без сотен обработчиков
  $("#list", el).addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#more")) {
      pageLimit += PAGE;
      return renderList(true);
    }
    const card = t.closest<HTMLElement>("[data-key]");
    if (!card) return;
    const l = state.schedule?.lessons.find((x) => x.key === card.dataset.key && String(x.buildingId) === card.dataset.b);
    if (l) openLessonSheet(l);
  });
}

function renderStats() {
  const s = state.schedule!;
  const inScope = s.lessons.filter((l) => inBuilding(l) && notPast(l));
  const free = inScope.filter((l) => l.available > 0);
  const seats = free.reduce((a, l) => a + l.available, 0);
  const secFree = new Set(free.map((l) => l.section));
  const secAll = new Set(inScope.map((l) => l.section));

  $("#topTitle").textContent = free.length ? `${free.length} ${plural(free.length, "занятие", "занятия", "занятий")} со свободными местами` : "Свободных мест пока нет";
  $("#streakArc").setAttribute("stroke-dasharray", `${inScope.length ? Math.round((100 * free.length) / inScope.length) : 0} 100`);

  countUp($("#sFree"), free.length);
  $("#sFreeHint").textContent = `из ${inScope.length} в расписании`;
  countUp($("#sSec"), secFree.size);
  $("#sSecOf").textContent = `/ ${secAll.size}`;
  countUp($("#sSeats"), seats);
  $("#sSeatsHint").textContent = free.length ? `≈ ${Math.round(seats / free.length)} на занятие` : "—";
  countUp($("#sCan"), free.filter((l) => l.canSign).length);

  if (f.building !== "all" && !s.buildings.some((b) => String(b.id) === f.building)) f.building = "all";
  $("#buildingLbl").textContent = f.building === "all" ? "Все корпуса" : (s.buildings.find((b) => String(b.id) === f.building)?.name ?? "Корпус");
  $("#rangeLbl").textContent = rangeLabel(f.range);
  renderChart();
}

function renderChart() {
  const s = state.schedule!;
  const days: string[] = [];
  for (const d = asDate(s.dateStart); ymd(d) <= s.dateEnd && days.length < 62; d.setDate(d.getDate() + 1)) days.push(ymd(d));
  // один-два дня — график бессмысленен, остаются карточки-счётчики
  $(".chart-card").hidden = days.length < 3;
  if (days.length < 3) return;
  const by: Record<string, number> = Object.fromEntries(days.map((d) => [d, 0]));
  for (const l of s.lessons) if (inBuilding(l) && l.date in by) by[l.date]! += l.available;
  const max = Math.max(1, ...Object.values(by));
  const today = TODAY();
  $("#chartRange").textContent = `${fmtShort.format(asDate(days[0]!))} – ${fmtShort.format(asDate(days[days.length - 1]!))}`;
  const chart = $("#chart");
  // больше двух недель на узком экране — скроллим по неделям, а не сжимаем в нечитаемое
  chart.classList.toggle("wide", days.length > 14 || (days.length > 7 && innerWidth < 380));
  chart.innerHTML = days
    .map(
      (d, i) => `<button class="bar-col ${d === today ? "today" : ""} ${by[d] ? "" : "zero"} ${d < today ? "past" : ""} ${i === 0 || asDate(d).getDay() === 1 ? "week-snap" : ""}" data-day="${d}" title="${esc(fmtDay.format(asDate(d)))}: ${by[d]} мест">
        <span class="bar-val">${by[d] || ""}</span>
        <span class="bar" style="height:${Math.max(3, (by[d]! / max) * 100)}%;animation-delay:${Math.min(i, 20) * 20}ms"></span>
        <span class="bar-lbl">${fmtWd.format(asDate(d)).slice(0, 2)}</span>
      </button>`,
    )
    .join("");
  chart.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(".bar-col");
    if (b) jumpToDay(b.dataset.day!);
  };
  // прокрутить к текущей неделе
  const todayIdx = days.indexOf(today);
  if (todayIdx >= 7) requestAnimationFrame(() => $<HTMLElement>(`.bar-col[data-day="${days[todayIdx - ((asDate(today).getDay() + 6) % 7)]}"]`)?.scrollIntoView({ block: "nearest", inline: "start" }));

  const future = days.filter((d) => d >= today).sort((a, b) => by[b]! - by[a]!);
  const best = future[0];
  const topSec = Object.entries(
    s.lessons.filter((l) => inBuilding(l) && l.available > 0 && l.date >= today).reduce<Record<string, number>>((a, l) => ((a[l.section] = (a[l.section] ?? 0) + l.available), a), {}),
  ).sort((a, b) => b[1] - a[1])[0];
  $("#chartSummary").innerHTML =
    best && by[best]
      ? `Больше всего мест — <u>${esc(fmtDay.format(asDate(best)))}</u> (${by[best]}).${topSec ? ` Самая свободная секция — <u>${esc(topSec[0])}</u>.` : ""}`
      : "На ближайшие дни свободных мест нет — поставь 🎯 ловушку или правило.";
}

const CHEVRON = `<svg class="i chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>`;

function openBuildingMenu(anchor: HTMLButtonElement) {
  if (popoverOpenOn(anchor)) return closePopover();
  const s = state.schedule;
  if (!s) return;
  haptic.press();
  const opts = [{ id: "all", name: "Все корпуса" }, ...s.buildings.map((b) => ({ id: String(b.id), name: b.name }))];
  openPopover(
    anchor,
    `<div class="menu" role="listbox" aria-label="Корпус">${opts
      .map((o) => `<button class="menu-i" role="option" data-v="${esc(o.id)}" aria-selected="${o.id === f.building}"><span>${esc(o.name)}</span>${icon("check")}</button>`)
      .join("")}</div>`,
    (el) => {
      const menu = $(".menu", el);
      fluidHover(menu, ".menu-i");
      menu.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".menu-i");
        if (!b) return;
        $$(".menu-i", menu).forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        haptic.tap();
        f.building = b.dataset.v!;
        store.set("building", f.building);
        f.sections.clear();
        pageLimit = PAGE;
        setTimeout(() => closePopover(), 90); // дать увидеть галочку
        renderStats();
        renderList();
      });
    },
    { className: "pop-menu" },
  );
}

function renderChips() {
  const counts: Record<string, number> = {};
  for (const l of filtered(true)) counts[l.section] = (counts[l.section] ?? 0) + 1;
  for (const s of f.sections) counts[s] ??= 0;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  $("#chips").innerHTML =
    (f.sections.size ? `<button class="chip" data-reset>Сбросить ×</button>` : "") +
    entries.map(([n, c]) => `<button class="chip" data-name="${esc(n)}" aria-pressed="${f.sections.has(n)}">${esc(n)} <span class="n">${c}</span></button>`).join("");
}

function ring(l: Lesson) {
  const pct = l.limit ? Math.min(100, Math.round((100 * l.available) / l.limit)) : 0;
  return `<div class="ring ${pct && pct < 20 ? "low" : ""}"><svg viewBox="0 0 48 48"><circle class="track" cx="24" cy="24" r="20" pathLength="100"/><circle class="val" cx="24" cy="24" r="20" pathLength="100" stroke-dasharray="${pct} 100"/></svg><div class="num"><b>${l.available}</b><i>из ${l.limit}</i></div></div>`;
}

function lessonCard(l: Lesson, i: number) {
  const mine = state.chosenIds.has(l.id);
  const tags = [
    mine ? `<span class="tag ok">✓ ты записан</span>` : "",
    l.freeVisit ? `<span class="tag">свободное посещение</span>` : `<span class="tag accent">секция</span>`,
    f.building === "all" ? `<span class="tag">${esc(l.buildingName)}</span>` : "",
    l.canSign ? "" : `<span class="tag bad">запись закрыта</span>`,
    l.intersection ? `<span class="tag warn">пересечение с парами</span>` : "",
  ].join("");
  return `<button class="card lesson ${i < 12 ? "enter" : ""} ${l.available ? "" : "full"} ${mine ? "mine" : ""}" style="--i:${i}" data-key="${esc(l.key)}" data-b="${l.buildingId}">
    <div class="t">${esc(l.start)}<small>– ${esc(l.end)}</small></div>
    ${ring(l)}
    <div class="name">${esc(l.section)}</div>
    <div class="who">
      ${l.teacher ? `<span>${icon("user")}<b>${esc(l.teacher)}</b></span>` : ""}
      ${l.room ? `<span>${icon("pin")}<b>${esc(l.room)}</b></span>` : ""}
    </div>
    <div class="tags">${tags}</div>
  </button>`;
}

function renderList(keepScroll = false) {
  if (!$("#list")) return;
  renderChips();
  const list = filtered();
  const el = $("#list");
  if (!list.length) {
    el.innerHTML = `<div class="nothing">Ничего не нашлось. Сними пару фильтров — или поставь 🎯 на занятие без мест.</div>`;
    return;
  }
  const y = keepScroll ? scrollY : 0;
  if (f.view === "days") {
    const shown = list.slice(0, pageLimit);
    const by: Record<string, Lesson[]> = {};
    for (const l of shown) (by[l.date] ??= []).push(l);
    let i = 0;
    el.innerHTML =
      Object.entries(by)
        .map(
          ([d, ls]) => `<section class="day" id="d-${d}">
          <div class="day-head"><h2>${esc(fmtDay.format(asDate(d)))}</h2>${d === TODAY() ? `<span class="today-tag">сегодня</span>` : ""}<span class="c">${ls.length} ${plural(ls.length, "занятие", "занятия", "занятий")}</span></div>
          <div class="grid">${ls.map((l) => lessonCard(l, i++)).join("")}</div></section>`,
        )
        .join("") + (list.length > shown.length ? `<div class="actions" style="justify-content:center;margin-top:18px"><button class="btn btn-tertiary" id="more">Показать ещё ${list.length - shown.length}</button></div>` : "");
  } else {
    const by: Record<string, Lesson[]> = {};
    for (const l of list) (by[l.section] ??= []).push(l);
    const LIMIT = 6;
    el.innerHTML =
      `<div class="grid" style="margin-top:14px">` +
      Object.entries(by)
        .map(([s, ls]) => [s, ls, ls.reduce((a, l) => a + l.available, 0)] as const)
        .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0], "ru"))
        .map(
          ([s, ls, sum], i) => `<article class="card sec ${i < 8 ? "enter" : ""}" style="--i:${i}">
            <div class="sec-head"><h3>${esc(s)}</h3><div class="big">${sum}<small>мест</small></div></div>
            <div class="muted">${esc([...new Set(ls.map((l) => l.teacher).filter(Boolean))].slice(0, 3).join(", "))}</div>
            <div class="sec-rows">${ls
              .map(
                (l, j) => `<button class="sec-row ${l.available ? "" : "full"}" data-key="${esc(l.key)}" data-b="${l.buildingId}" ${j >= LIMIT ? "hidden" : ""}>
                <span class="d">${esc(fmtWd.format(asDate(l.date)))}, ${esc(fmtShort.format(asDate(l.date)))}</span>
                <span class="tm">${esc(l.start)}–${esc(l.end)}</span>
                <span class="tc">${esc(l.room || l.buildingName)}</span>
                <span class="s">${state.chosenIds.has(l.id) ? "✓ " : ""}${l.available}/${l.limit}</span></button>`,
              )
              .join("")}</div>
            ${ls.length > LIMIT ? `<button class="btn btn-ghost" data-expand>Ещё ${ls.length - LIMIT}</button>` : ""}
          </article>`,
        )
        .join("") +
      `</div>`;
    $$<HTMLButtonElement>("[data-expand]", el).forEach(
      (b) =>
        (b.onclick = (e) => {
          e.stopPropagation();
          $$(".sec-row[hidden]", b.parentElement!).forEach((r) => (r.hidden = false));
          b.remove();
        }),
    );
  }
  if (keepScroll) scrollTo({ top: y });
}

function jumpToDay(d: string) {
  if (f.view !== "days") $<HTMLButtonElement>('#viewSeg [data-view="days"]').click();
  const target = $(`#d-${d}`);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  else toast("В этот день по фильтрам ничего нет");
}

// ---------- карточка занятия ----------

export function openLessonSheet(l: Lesson) {
  haptic.press();
  const mine = state.chosenIds.has(l.id);
  const open = l.available > 0 && l.canSign;
  const pct = l.limit ? Math.round((100 * l.available) / l.limit) : 0;
  openSheet(
    `<div class="sheet-head"><h2>${esc(l.section)}</h2></div>
    <div class="row-card"><div class="grow">
      <div class="big" style="margin:0">${esc(l.start)}<small>– ${esc(l.end)}</small></div>
      <div class="muted" style="margin-top:4px">${esc(fmtDay.format(asDate(l.date)))}</div>
    </div>${ring(l)}</div>
    <dl class="kv">
      <dt>Преподаватель</dt><dd>${esc(l.teacher || "—")}</dd>
      <dt>Где</dt><dd>${esc(l.room || "—")}</dd>
      <dt>Корпус</dt><dd>${esc(l.buildingName)}</dd>
      <dt>Места</dt><dd>${l.available} из ${l.limit} (${pct}%)</dd>
      ${l.intersection ? `<dt>⚠️</dt><dd>Пересекается с парами</dd>` : ""}
      ${!l.canSign ? `<dt>⛔</dt><dd>Сайт сейчас не даёт записаться</dd>` : ""}
      ${l.comment ? `<dt>Комментарий</dt><dd>${esc(l.comment)}</dd>` : ""}
    </dl>
    <div class="actions" style="flex-direction:column">
      ${mine ? `<button class="btn btn-danger block lg" id="aUnsign">${icon("x")}<span>Отписаться</span></button>` : ""}
      ${!mine && open ? `<button class="btn btn-ok block lg" id="aSign">${icon("check")}<span>Записаться</span></button>` : ""}
      ${!mine && !open ? `<button class="btn btn-primary block lg" id="aCatch">${icon("target")}<span>Поймать место</span></button><p class="muted" style="margin:0;text-align:center">Проверяю раз в минуту и запишу, как только освободится</p>` : ""}
      <button class="btn btn-tertiary block" id="aWatch">${icon("bell")}<span>Уведомлять о «${esc(l.section.length > 24 ? l.section.slice(0, 23) + "…" : l.section)}»</span></button>
    </div>`,
    (body) => {
      $<HTMLButtonElement>("#aSign", body)?.addEventListener("click", (e) =>
        withLoading(e.currentTarget as HTMLButtonElement, async () => {
          const r = await api.sign(l);
          if (!r.ok) throw new Error(r.message);
          state.chosenIds.add(l.id);
          l.available = Math.max(0, l.available - 1);
          emit("chosen");
          closeSheet();
          toast("Записан!");
        }),
      );
      $<HTMLButtonElement>("#aUnsign", body)?.addEventListener("click", (e) =>
        withLoading(e.currentTarget as HTMLButtonElement, async () => {
          const r = await api.unsign({ id: l.id, section: l.section, date: l.date, start: l.start });
          if (!r.ok) throw new Error(r.message);
          state.chosenIds.delete(l.id);
          l.available += 1;
          emit("chosen");
          closeSheet();
          toast("Запись отменена");
        }),
      );
      $<HTMLButtonElement>("#aCatch", body)?.addEventListener("click", (e) =>
        withLoading(e.currentTarget as HTMLButtonElement, async () => {
          await api.createCatch(l);
          state.catches = null;
          emit("alerts");
          closeSheet();
          toast("🎯 Ловлю место — напишу в чат");
        }),
      );
      $<HTMLButtonElement>("#aWatch", body).onclick = () =>
        openWatcherEditor(null, { name: l.section, filter: { sections: [l.section], weeks: 2, onlyCanSign: true } });
    },
  );
}

export function initSchedule() {
  on("me", renderSchedule);
  on("schedule", renderSchedule);
  on("chosen", () => state.schedule && renderList(true));
  addEventListener("resize", debounce(() => moveInd($("#viewSeg")), 100));
}
