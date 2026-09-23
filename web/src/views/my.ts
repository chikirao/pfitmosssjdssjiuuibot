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
    data = await api.my();
    state.chosenIds = new Set(data.chosen.map((c) => c.id));
    emit("chosen");
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    loadingMy = false;
  }
  renderMy();
}

function renderMy() {
  const el = root();
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
