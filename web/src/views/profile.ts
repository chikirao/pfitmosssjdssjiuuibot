import { LIMITS, type UserSettings } from "../../../src/shared/types";
import { api } from "../api";
import { emit, on, state } from "../state";
import { confirmDialog, haptic } from "../tg";
import { $, $$, esc, fmtUnix, icon, toast, withLoading } from "../ui";
import { openTokenSheet } from "./token";

const root = () => $("#view-profile");

function tokenCard() {
  const t = state.me!.token;
  const now = Date.now() / 1000;
  const status =
    t.status === "ok"
      ? `<span class="status-dot ok"></span> Подключён`
      : t.status === "expired"
        ? `<span class="status-dot bad"></span> Истёк — нужен новый`
        : `<span class="status-dot"></span> Не подключён`;
  const refresh =
    t.status !== "ok"
      ? ""
      : t.refreshExp === null
        ? `<dt>Продление</dt><dd style="color:var(--warn)">нет refresh — умрёт через ~30 мин</dd>`
        : t.refreshExp === 0
          ? `<dt>Продление</dt><dd>автоматически, без срока</dd>`
          : `<dt>Сессия ИТМО до</dt><dd>${t.refreshExp > now ? fmtUnix(t.refreshExp) : "истекла"}</dd>`;
  return `<div class="card enter">
    <div class="card-head">${icon("key")} Токен my.itmo.ru</div>
    <dl class="kv"><dt>Статус</dt><dd style="display:flex;gap:6px;align-items:center;justify-content:flex-end">${status}</dd>${refresh}</dl>
    <div class="actions">
      <button class="btn ${t.status === "ok" ? "btn-tertiary" : "btn-primary"}" id="pToken">${t.status === "ok" ? "Сменить токен" : "Подключить"}</button>
      ${t.status !== "none" ? `<button class="btn btn-ghost" id="pTokenDel">Удалить токен</button>` : ""}
    </div>
    ${t.status === "ok" ? `<p class="muted" style="margin:10px 0 0">Бот сам обновляет доступ каждые ~25 минут, пока жива сессия ИТМО. Когда она закончится — напишу в чат.</p>` : ""}
  </div>`;
}

function settingsCard(s: UserSettings) {
  const paused = state.me!.pausedUntil > Date.now() / 1000;
  return `<div class="card enter" style="--i:1">
    <div class="card-head">${icon("bolt")} Автозапись</div>
    <div class="setting"><div class="grow">Автозаписей в неделю<div class="sub">«Записывать сам» и ловушки. 0 — выключено. У ИТМО максимум 2 в неделю</div></div>
      <div class="stepper"><button class="btn btn-tertiary" style="width:36px;padding:0" data-step="-1">−</button><b id="sLimit">${s.autoWeeklyLimit}</b><button class="btn btn-tertiary" style="width:36px;padding:0" data-step="1">+</button></div></div>
    <div class="setting"><div class="grow">Тратить последнюю запись семестра<div class="sub">Если осталась одна — её только вручную</div></div>
      <button class="switch" role="switch" data-set="autoUseLastAttempt" aria-checked="${s.autoUseLastAttempt}"></button></div>
    <div class="setting"><div class="grow">Записывать при пересечении с парами</div>
      <button class="switch" role="switch" data-set="autoAllowIntersection" aria-checked="${s.autoAllowIntersection}"></button></div>
  </div>
  <div class="card enter" style="--i:2;margin-top:12px">
    <div class="card-head">${icon("moon")} Тишина</div>
    <div class="setting"><div class="grow">Тихие часы<div class="sub">Уведомления о новых местах придут после. Автозапись работает</div></div>
      <button class="switch" role="switch" id="quietSw" aria-checked="${!!(s.quietFrom && s.quietTo)}"></button></div>
    ${
      s.quietFrom && s.quietTo
        ? `<div class="inline" style="padding-bottom:6px"><span class="muted">с</span><input class="field time" type="time" id="qFrom" value="${s.quietFrom}"><span class="muted">до</span><input class="field time" type="time" id="qTo" value="${s.quietTo}"></div>`
        : ""
    }
    <div class="setting"><div class="grow">${paused ? `Пауза до ${fmtUnix(state.me!.pausedUntil)}` : "Пауза уведомлений"}</div>
      <div class="inline">${paused ? `<button class="btn btn-tertiary" data-pause="0">Снять</button>` : [1, 8, 24].map((h) => `<button class="pill sm" data-pause="${h}">${h} ч</button>`).join("")}</div></div>
  </div>`;
}

function renderProfile() {
  const el = root();
  const me = state.me;
  if (!me) {
    el.innerHTML = `<div class="skeleton"></div>`;
    return;
  }
  el.innerHTML = `
    <div class="hero"><h1>${esc(me.firstName ?? "Профиль")}</h1><span class="meta">${me.username ? "@" + esc(me.username) : ""}</span></div>
    <div class="list">${tokenCard()}</div>
    <div style="margin-top:12px">${settingsCard(me.settings)}</div>
    <div class="card enter" style="--i:3;margin-top:12px">
      <div class="card-head">${icon("shield")} Данные</div>
      <p class="muted" style="margin:8px 0 0">Храню: зашифрованные токены ИТМО, твои правила, ловушки и журнал записей за 120 дней. Лимиты: до ${LIMITS.maxWatchers} правил, до ${LIMITS.maxActiveCatches} ловушек.</p>
      <div class="actions"><button class="btn btn-danger" id="pForget">${icon("trash")}<span>Удалить все мои данные</span></button></div>
    </div>`;

  $<HTMLButtonElement>("#pToken", el).onclick = () => openTokenSheet();
  $<HTMLButtonElement>("#pTokenDel", el)?.addEventListener("click", async (e) => {
    if (!(await confirmDialog("Удалить токен? Правила и ловушки перестанут работать."))) return;
    await withLoading(e.currentTarget as HTMLButtonElement, async () => {
      await api.deleteToken();
      state.me!.token = { status: "none", accessExp: null, refreshExp: null };
      emit("me");
    });
  });

  const save = async (patch: Partial<UserSettings>) => {
    try {
      state.me!.settings = await api.settings(patch);
      haptic.tap();
    } catch (e) {
      toast((e as Error).message, true);
    }
    renderProfile();
  };
  $$<HTMLButtonElement>("[data-step]", el).forEach(
    (b) => (b.onclick = () => save({ autoWeeklyLimit: Math.min(LIMITS.maxAutoWeekly, Math.max(0, me.settings.autoWeeklyLimit + Number(b.dataset.step))) })),
  );
  $$<HTMLButtonElement>("[data-set]", el).forEach((b) => {
    const k = b.dataset.set as "autoUseLastAttempt" | "autoAllowIntersection";
    b.onclick = () => save({ [k]: !me.settings[k] });
  });
  $<HTMLButtonElement>("#quietSw", el).onclick = () => save(me.settings.quietFrom && me.settings.quietTo ? { quietFrom: null, quietTo: null } : { quietFrom: "23:00", quietTo: "08:00" });
  for (const id of ["qFrom", "qTo"] as const) {
    $<HTMLInputElement>(`#${id}`, el)?.addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).value;
      if (v) save(id === "qFrom" ? { quietFrom: v } : { quietTo: v });
    });
  }
  $$<HTMLButtonElement>("[data-pause]", el).forEach(
    (b) =>
      (b.onclick = () =>
        withLoading(b, async () => {
          const r = await api.pause(Number(b.dataset.pause));
          state.me!.pausedUntil = r.pausedUntil;
          toast(r.pausedUntil ? "Уведомления на паузе" : "Уведомления включены");
          renderProfile();
        })),
  );
  $<HTMLButtonElement>("#pForget", el).onclick = async (e) => {
    if (!(await confirmDialog("Удалить токен, правила, ловушки и историю? Это нельзя отменить."))) return;
    await withLoading(e.currentTarget as HTMLButtonElement, async () => {
      await api.forget();
      toast("Данные удалены");
      state.me = await api.me();
      state.schedule = null;
      state.watchers = null;
      state.catches = null;
      emit("me");
    });
  };
}

export function initProfile() {
  on("me", renderProfile);
}
