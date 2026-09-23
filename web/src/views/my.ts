import type { MyResponse } from "../../../src/shared/types";
import { api } from "../api";
import { emit, hasToken, on, state } from "../state";
import { confirmDialog } from "../tg";
import { $, $$, ago, asDate, esc, fmtDay, icon, plural, TODAY, toast, withLoading } from "../ui";
import { openTokenSheet } from "./token";

let data: MyResponse | null = null;
let loadingMy = false;
const root = () => $("#view-my");

const SOURCE: Record<string, string> = { manual: "вручную", offer: "по предложению", auto: "автозапись", catch: "ловушка" };

export async function loadMy() {
  if (!hasToken() || loadingMy) return;
  loadingMy = true;
  try {
    const next = await api.my();
    // те же данные — не перерисовываем (иначе анимация появления проиграется второй раз)
    const same = data !== null && JSON.stringify(next) === JSON.stringify(data);
    data = next;
    if (same) return;
    state.chosenIds = new Set(data.chosen.map((c) => c.id));
    emit("chosen");
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    loadingMy = false;
  }
  renderMy();
}

/** Круг как на my.itmo.ru: шкала до 100, сначала баллы за посещения, за ними — дополнительные. */
function scoreCard(s: MyResponse["score"] | undefined) {
  if (!s || s.attendance === null) return "";
  const att = s.attendance;
  const other = s.other ?? 0;
  const total = Math.round(att + other);
  const a = Math.min(100, att);
  const o = Math.min(100 - a, other);
  const active = att >= 60; // доп. баллы засчитываются только после 60 за посещения
  const r = 52;
  return `<h1 class="page-title">Баллы</h1>
  <div class="card score enter">
    <div class="score-ring ${active ? "" : "inactive"}">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle class="track" cx="60" cy="60" r="${r}" pathLength="100"/>
        ${o > 0 ? `<circle class="other" cx="60" cy="60" r="${r}" pathLength="100" stroke-dasharray="${o} 100" stroke-dashoffset="${-a}"/>` : ""}
        ${a > 0 ? `<circle class="att" cx="60" cy="60" r="${r}" pathLength="100" stroke-dasharray="${a} 100"/>` : ""}
      </svg>
      <div class="score-num"><b>${total}</b><i>из 100</i></div>
    </div>
    <div class="score-side">
      ${s.semester ? `<div class="muted">${esc(s.semester)}</div>` : ""}
      ${
        total
          ? `<div class="score-row"><span class="sw att"></span><b>${Math.round(att)}</b> за посещения <span class="muted">/ 60</span></div>
        <div class="score-row"><span class="sw other"></span><b>${Math.round(other)}</b> дополнительных${active ? "" : ` <span class="muted">(неактивны)</span>`}</div>`
          : `<div><b>Пока нет баллов</b></div><div class="muted">Появятся после посещений, соревнований или нормативов</div>`
      }
      <div class="hint">Зачёт — от 100 баллов, из них минимум 60 за посещения${att < 60 ? `: осталось ${Math.ceil(60 - att)}` : ""}</div>
    </div>
  </div>`;
}

function renderMy() {
  const el = root();
  // обновление уже показанного экрана — без повторной анимации появления
  el.classList.toggle("calm", !!el.querySelector(".score, .hero"));
  if (!hasToken()) {
    el.innerHTML = `<div class="card empty"><h2>Нет токена ИТМО</h2><p>Подключи my.itmo.ru, чтобы видеть свои записи.</p><button class="soft" id="myConnect">${icon("key")} Подключить</button></div>`;
    $<HTMLButtonElement>("#myConnect", el).onclick = () => openTokenSheet(loadMy);
    return;
  }
  if (!data) {
    el.innerHTML = `<div class="skeleton"></div>`;
    return;
  }
  const today = TODAY();
  const future = data.chosen.filter((c) => c.date >= today);
  const past = data.chosen.filter((c) => c.date < today).slice(-5).reverse();
  const a = data.attempts;
  el.innerHTML = `
    ${scoreCard(data.score)}
    <div class="hero"><h1>Мои записи</h1><span class="meta">${future.length} ${plural(future.length, "предстоящая", "предстоящие", "предстоящих")}</span></div>
    ${
      a.free !== null
        ? `<div class="card enter" style="margin-bottom:12px"><div class="card-head">${icon("ticket")} Записей в семестре</div><div class="big">${a.free}<small>${a.total !== null ? `из ${a.total}` : ""} осталось</small></div><div class="hint">Лимит ИТМО: ${a.total ?? "—"} занятий за семестр и не больше 2 в неделю</div></div>`
        : ""
    }
    <div class="list">
      ${
        future.length
          ? future
              .map(
                (c, i) => `<div class="card row-card enter" style="--i:${i + 1}">
                <div class="grow"><div class="title">${esc(c.section)}</div>
                <div class="sub">${esc(fmtDay.format(asDate(c.date)))}, ${esc(c.start)}${c.end ? `–${esc(c.end)}` : ""}</div>
                ${c.room ? `<div class="sub">${icon("pin")} ${esc(c.room)}</div>` : ""}</div>
                <button class="btn btn-danger" data-unsign="${c.id}">Отписаться</button></div>`,
              )
              .join("")
          : `<div class="card empty"><p style="margin:0">Предстоящих записей нет. Выбери занятие в «Расписании».</p></div>`
      }
    </div>
    ${past.length ? `<h2 class="section-title">Недавние</h2><div class="list">${past.map((c) => `<div class="card row-card" style="opacity:.7"><div class="grow"><div class="title">${esc(c.section)}</div><div class="sub">${esc(fmtDay.format(asDate(c.date)))}, ${esc(c.start)}</div></div></div>`).join("")}</div>` : ""}
    ${
      data.signups.length
        ? `<h2 class="section-title">История действий бота</h2><div class="card"><div class="list" style="gap:0">${data.signups
            .slice(0, 12)
            .map(
              (s) => `<div class="setting"><div class="grow"><div>${s.ok ? "✅" : "❌"} ${s.action === "sign" ? "Запись" : "Отписка"}: ${esc(s.section ?? `#${s.lessonId}`)}${s.date ? ` · ${esc(s.date.slice(8, 10))}.${esc(s.date.slice(5, 7))} ${esc(s.start ?? "")}` : ""}</div>
              <div class="sub">${SOURCE[s.source] ?? esc(s.source)} · ${ago(s.createdAt)}${s.message ? ` · ${esc(s.message)}` : ""}</div></div></div>`,
            )
            .join("")}</div></div>`
        : ""
    }`;
  $$<HTMLButtonElement>("[data-unsign]", el).forEach(
    (b) =>
      (b.onclick = async () => {
        const c = data!.chosen.find((x) => x.id === Number(b.dataset.unsign))!;
        if (!(await confirmDialog(`Отписаться от «${c.section}» ${c.start}?`))) return;
        await withLoading(b, async () => {
          const r = await api.unsign({ id: c.id, section: c.section, date: c.date, start: c.start });
          if (!r.ok) throw new Error(r.message);
          toast("Запись отменена");
          await loadMy();
        });
      }),
  );
}

export function initMy() {
  on("me", renderMy);
}
