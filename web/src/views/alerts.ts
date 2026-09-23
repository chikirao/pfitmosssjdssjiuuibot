import { LIMITS, type LessonFilter, type Watcher, type WatcherAction, type WatcherInput } from "../../../src/shared/types";
import { api } from "../api";
import { emit, hasToken, on, state } from "../state";
import { confirmDialog, haptic } from "../tg";
import { $, $$, asDate, closeSheet, esc, fmtDay, fmtUnix, icon, openSheet, toast, WD, withLoading } from "../ui";

const root = () => $("#view-alerts");

const ACTIONS: Record<WatcherAction, { title: string; hint: string; icon: string }> = {
  notify: { title: "Сообщать", hint: "Просто напишу, что появилось место", icon: "bell" },
  offer: { title: "Предлагать запись", hint: "Пришлю «Записать вас?» с кнопками Да / Нет", icon: "check" },
  auto: { title: "Записывать сам", hint: "Запишу при первой возможности — в рамках лимитов ИТМО", icon: "bolt" },
};

export function describe(w: WatcherInput) {
  const when =
    w.mode === "interval"
      ? `каждые ${w.intervalMin} мин`
      : `${w.schedule!.days.length && w.schedule!.days.length < 7 ? w.schedule!.days.map((d) => WD[d]).join(", ") : "каждый день"} в ${w.schedule!.time}`;
  const fl = w.filter;
  const what = [
    fl.sections?.length ? fl.sections.join(", ") : fl.query ? `«${fl.query}»` : "все секции",
    fl.days?.length ? fl.days.map((d) => WD[d]).join(", ") : "",
    fl.timeFrom || fl.timeTo ? `${fl.timeFrom ?? "…"}–${fl.timeTo ?? "…"}` : "",
  ].filter(Boolean);
  return { what: what.join(" · "), when };
}

export async function loadAlerts() {
  if (!hasToken() && state.me?.token.status === "none") {
    state.watchers = [];
    state.catches = [];
    return emit("alerts");
  }
  try {
    const [w, c] = await Promise.all([api.watchers(), api.catches()]);
    state.watchers = w;
    state.catches = c;
  } catch (e) {
    toast((e as Error).message, true);
    state.watchers ??= [];
    state.catches ??= [];
  }
  emit("alerts");
}

function renderAlerts() {
  const el = root();
  if (!state.watchers || !state.catches) {
    el.innerHTML = `<div class="skeleton"></div>`;
    if (state.me) loadAlerts();
    return;
  }
  const active = state.catches.filter((c) => c.status === "active");
  const finished = state.catches.filter((c) => c.status !== "active").slice(0, 8);
  el.innerHTML = `
    <div class="hero"><h1>Уведомления</h1><span class="meta">${state.watchers.length}/${LIMITS.maxWatchers} правил</span></div>
    <div class="list">
      ${state.watchers
        .map((w, i) => {
          const d = describe(w);
          return `<div class="card row-card enter" style="--i:${i}" data-w="${w.id}">
            <div class="grow" data-edit>
              <div class="title">${esc(w.name)}</div>
              <div class="sub">${esc(d.what)}</div>
              <div class="sub">${icon(w.mode === "interval" ? "clock" : "cal")} ${esc(d.when)} · ${icon(ACTIONS[w.action].icon)} ${ACTIONS[w.action].title.toLowerCase()}</div>
            </div>
            <button class="switch" role="switch" aria-checked="${w.enabled}" aria-label="Включено" data-toggle></button>
          </div>`;
        })
        .join("")}
      <button class="soft" id="addWatcher" style="justify-self:start">${icon("plus")} Новое правило</button>
    </div>

    <h2 class="section-title">🎯 Поймать место</h2>
    <div class="list">
      ${
        active.length
          ? active
              .map(
                (c) => `<div class="card row-card"><div class="grow"><div class="title">${esc(c.section)}</div>
                <div class="sub">${esc(fmtDay.format(asDate(c.date)))}, ${esc(c.start)} · проверяю раз в минуту</div></div>
                <button class="btn btn-ghost" data-cancel="${c.id}" aria-label="Отменить">${icon("x")}</button></div>`,
              )
              .join("")
          : `<div class="muted" style="padding:0 4px">Нет активных ловушек. Открой занятие без мест в «Расписании» и нажми «Поймать место».</div>`
      }
      ${
        finished.length
          ? `<details style="margin-top:4px"><summary class="muted" style="cursor:pointer;padding:4px">История</summary><div class="list" style="margin-top:8px">${finished
              .map(
                (c) =>
                  `<div class="card row-card" style="opacity:.75"><div class="grow"><div class="title">${c.status === "done" ? "✅" : c.status === "failed" ? "❌" : "⌛"} ${esc(c.section)}</div><div class="sub">${esc(fmtDay.format(asDate(c.date)))}, ${esc(c.start)} — ${esc(c.result ?? c.status)}</div></div></div>`,
              )
              .join("")}</div></details>`
          : ""
      }
    </div>`;

  $<HTMLButtonElement>("#addWatcher", el).onclick = () => openWatcherEditor(null);
  $$<HTMLElement>("[data-w]", el).forEach((card) => {
    const w = state.watchers!.find((x) => x.id === Number(card.dataset.w))!;
    $("[data-edit]", card).onclick = () => openWatcherEditor(w);
    const sw = $<HTMLButtonElement>("[data-toggle]", card);
    sw.onclick = async () => {
      haptic.tap();
      sw.setAttribute("aria-checked", String(!w.enabled));
      try {
        Object.assign(w, await api.toggleWatcher(w.id));
      } catch (e) {
        sw.setAttribute("aria-checked", String(w.enabled));
        toast((e as Error).message, true);
      }
    };
  });
  $$<HTMLButtonElement>("[data-cancel]", el).forEach(
    (b) =>
      (b.onclick = () =>
        withLoading(b, async () => {
          await api.cancelCatch(Number(b.dataset.cancel));
          await loadAlerts();
        })),
  );
}

// ---------- редактор правила ----------

const toggle = <T>(set: T[] | undefined, v: T) => {
  const s = new Set(set ?? []);
  s.has(v) ? s.delete(v) : s.add(v);
  return [...s];
};

export function openWatcherEditor(w: Watcher | null, preset?: Partial<WatcherInput>) {
  if (!hasToken()) return toast("Сначала подключи токен ИТМО в «Профиле»", true);
  const draft: WatcherInput = w
    ? { name: w.name, enabled: w.enabled, filter: structuredClone(w.filter), mode: w.mode, intervalMin: w.intervalMin, schedule: w.schedule ? { ...w.schedule } : null, action: w.action }
    : { name: "", enabled: true, filter: { weeks: 2 }, mode: "interval", intervalMin: 15, schedule: null, action: "offer", ...preset };

  const sections = [...new Set((state.schedule?.lessons ?? []).map((l) => l.section))].sort((a, b) => a.localeCompare(b, "ru"));
  for (const s of draft.filter.sections ?? []) if (!sections.includes(s)) sections.unshift(s);
  const buildings = state.schedule?.buildings ?? [];

  const render = () => {
    const fl = draft.filter;
    const pill = (on: boolean, attrs: string, text: string) => `<button class="pill sm" ${attrs} aria-pressed="${on}">${text}</button>`;
    return `<div class="sheet-head"><h2>${w ? "Правило" : "Новое правило"}</h2>${w ? `<button class="btn btn-ghost" id="wDel" aria-label="Удалить">${icon("trash")}</button>` : ""}</div>

      <label class="field-label">Название</label>
      <input class="field" id="wName" maxlength="60" placeholder="${esc(fl.sections?.join(", ") || "Например: Йога по утрам")}" value="${esc(draft.name)}">

      <label class="field-label">Секции ${fl.sections?.length ? `<b>(${fl.sections.length})</b>` : "— любые"}</label>
      <div class="chips wrap-chips" id="wSections" style="max-height:168px;overflow:auto">${
        sections.length
          ? sections.map((s) => pill(!!fl.sections?.includes(s), `data-sec="${esc(s)}"`, esc(s))).join("")
          : `<span class="muted">Загрузи расписание, чтобы выбрать секции, или используй поиск ниже</span>`
      }</div>
      <input class="field" id="wQuery" placeholder="…или поиск по названию / преподавателю" value="${esc(fl.query ?? "")}" style="margin-top:6px">

      <label class="field-label">Дни недели</label>
      <div class="pills" id="wDays">${[1, 2, 3, 4, 5, 6, 7].map((d) => pill(!!fl.days?.includes(d), `data-day="${d}"`, WD[d]!)).join("")}</div>

      <label class="field-label">Начало занятия</label>
      <div class="inline"><span class="muted">с</span><input class="field time" id="wFrom" type="time" value="${fl.timeFrom ?? ""}"><span class="muted">до</span><input class="field time" id="wTo" type="time" value="${fl.timeTo ?? ""}"></div>

      ${
        buildings.length > 1
          ? `<label class="field-label">Корпуса ${fl.buildings?.length ? "" : "— все"}</label><div class="pills" id="wBuild">${buildings.map((b) => pill(!!fl.buildings?.includes(b.id), `data-b="${b.id}"`, esc(b.name))).join("")}</div>`
          : ""
      }

      <label class="field-label">Ещё</label>
      <div class="pills" id="wFlags">
        ${pill(!!fl.onlyCanSign, 'data-flag="onlyCanSign"', "Только куда можно записаться")}
        ${pill(!!fl.noIntersect, 'data-flag="noIntersect"', "Без пересечений с парами")}
        ${pill(!!fl.noFreeVisit, 'data-flag="noFreeVisit"', "Без свободного посещения")}
      </div>
      <div class="inline" style="margin-top:8px"><span class="muted">Смотреть вперёд:</span>${[1, 2, 3, 4].map((n) => pill((fl.weeks ?? 2) === n, `data-weeks="${n}"`, `${n} нед`)).join("")}</div>

      <label class="field-label">Когда проверять</label>
      <div class="seg-inline" id="wMode">
        <button data-mode="interval" aria-pressed="${draft.mode === "interval"}">⏱ Постоянно</button>
        <button data-mode="schedule" aria-pressed="${draft.mode === "schedule"}">📅 Сводка по расписанию</button>
      </div>
      ${
        draft.mode === "interval"
          ? `<div class="pills" style="margin-top:8px" id="wInt">${LIMITS.intervalChoices.map((m) => pill(draft.intervalMin === m, `data-int="${m}"`, m < 60 ? `${m} мин` : `${m / 60} ч`)).join("")}</div>
             <p class="muted" style="margin:6px 2px 0">Сообщу, когда место <b>появится</b> — не каждый раз, пока оно просто есть.</p>`
          : `<div class="inline" style="margin-top:8px"><span class="muted">в</span><input class="field time" id="wTime" type="time" value="${draft.schedule?.time ?? "08:00"}"><span class="muted">МСК</span></div>
             <div class="pills" style="margin-top:8px" id="wSDays">${[1, 2, 3, 4, 5, 6, 7].map((d) => pill(!!draft.schedule?.days.includes(d), `data-sday="${d}"`, WD[d]!)).join("")}</div>
             <p class="muted" style="margin:6px 2px 0">Дни не выбраны — каждый день. Пришлю список всего свободного по фильтру.</p>`
      }

      <label class="field-label">Что делать</label>
      <div class="list" id="wAction" style="gap:6px">${(Object.keys(ACTIONS) as WatcherAction[])
        .filter((a) => a !== "auto" || draft.mode === "interval")
        .map(
          (a) => `<button class="card row-card" data-act="${a}" style="padding:12px 14px;cursor:pointer;text-align:left;${draft.action === a ? "box-shadow:var(--shadow-card),inset 0 0 0 1.5px var(--fg)" : ""}">
            ${icon(ACTIONS[a].icon)}<div class="grow"><div class="title">${ACTIONS[a].title}</div><div class="sub">${ACTIONS[a].hint}</div></div>${draft.action === a ? icon("check") : ""}</button>`,
        )
        .join("")}</div>

      <div class="actions"><button class="btn btn-primary block lg" id="wSave">${w ? "Сохранить" : "Создать правило"}</button></div>`;
  };

  const mount = (body: HTMLElement) => {
    const sync = () => {
      draft.name = $<HTMLInputElement>("#wName", body).value;
      draft.filter.query = $<HTMLInputElement>("#wQuery", body).value.trim() || undefined;
      draft.filter.timeFrom = $<HTMLInputElement>("#wFrom", body).value || undefined;
      draft.filter.timeTo = $<HTMLInputElement>("#wTo", body).value || undefined;
      const t = $<HTMLInputElement>("#wTime", body);
      if (t && draft.schedule) draft.schedule.time = t.value || "08:00";
    };
    const rerender = () => {
      sync();
      const y = $<HTMLDialogElement>("#sheet").scrollTop;
      openSheet(render(), mount);
      $<HTMLDialogElement>("#sheet").scrollTop = y;
    };
    body.onclick = async (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>("button");
      if (!t) return;
      const fl: LessonFilter = draft.filter;
      const d = t.dataset;
      if (d.sec) fl.sections = toggle(fl.sections, d.sec);
      else if (d.day) fl.days = toggle(fl.days, Number(d.day));
      else if (d.b) fl.buildings = toggle(fl.buildings, Number(d.b));
      else if (d.flag) {
        const k = d.flag as "onlyCanSign" | "noIntersect" | "noFreeVisit";
        fl[k] = !fl[k] || undefined;
      } else if (d.weeks) fl.weeks = Number(d.weeks);
      else if (d.mode) {
        draft.mode = d.mode as WatcherInput["mode"];
        if (draft.mode === "schedule") {
          draft.schedule ??= { days: [], time: "08:00" };
          if (draft.action === "auto") draft.action = "offer";
        } else draft.intervalMin ??= 15;
      } else if (d.int) draft.intervalMin = Number(d.int);
      else if (d.sday && draft.schedule) draft.schedule.days = toggle(draft.schedule.days, Number(d.sday)).sort();
      else if (d.act) draft.action = d.act as WatcherAction;
      else if (t.id === "wSave") {
        sync();
        return withLoading(t as HTMLButtonElement, async () => {
          const payload = { ...draft, name: draft.name.trim() || draft.filter.sections?.join(", ").slice(0, 60) || draft.filter.query || "Все секции" };
          if (w) await api.updateWatcher(w.id, payload);
          else await api.createWatcher(payload);
          closeSheet();
          toast(w ? "Сохранено" : draft.action === "auto" ? "⚡ Правило создано — буду записывать сам" : "Правило создано");
          await loadAlerts();
        });
      } else if (t.id === "wDel" && w) {
        if (!(await confirmDialog(`Удалить правило «${w.name}»?`))) return;
        return withLoading(t as HTMLButtonElement, async () => {
          await api.deleteWatcher(w.id);
          closeSheet();
          await loadAlerts();
        });
      } else return;
      haptic.tap();
      rerender();
    };
  };
  openSheet(render(), mount);
}

export function initAlerts() {
  on("alerts", renderAlerts);
  on("me", () => {
    if (state.watchers === null && !$("#view-alerts").hidden) loadAlerts();
  });
}

export { fmtUnix };
