import "./style.css";
import { api, ApiError } from "./api";
import { emit, on, state } from "./state";
import { haptic, initTelegram } from "./tg";
import { $, $$, ago, esc, icon, initSheet, moveInd, toast } from "./ui";
import { initAlerts, loadAlerts } from "./views/alerts";
import { initMy, loadMy } from "./views/my";
import { initProfile } from "./views/profile";
import { initSchedule, loadSchedule } from "./views/schedule";

type Tab = "schedule" | "my" | "alerts" | "profile";
const TABS: Tab[] = ["schedule", "my", "alerts", "profile"];

initTelegram((dark) => (document.documentElement.dataset.theme = dark ? "dark" : "light"));
initSheet();
initSchedule();
initMy();
initAlerts();
initProfile();

let tab: Tab = "schedule";

function setTab(next: Tab, push = true) {
  tab = next;
  for (const t of TABS) $(`#view-${t}`).hidden = t !== next;
  const dock = $("#dock");
  $$("button", dock).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === next)));
  moveInd(dock);
  if (push) history.replaceState(null, "", `#${next}`);
  scrollTo({ top: 0 });
  if (next === "my") loadMy();
  if (next === "alerts") loadAlerts();
}

$$<HTMLButtonElement>("#dock button").forEach(
  (b) =>
    (b.onclick = () => {
      haptic.tap();
      setTab(b.dataset.tab as Tab);
    }),
);
addEventListener("resize", () => moveInd($("#dock")));
addEventListener("hashchange", () => {
  const t = location.hash.slice(1) as Tab;
  if (TABS.includes(t) && t !== tab && state.me) setTab(t, false);
});
document.fonts?.ready.then(() => moveInd($("#dock")));

$<HTMLButtonElement>("#reload").onclick = () => {
  haptic.press();
  if (tab === "schedule") loadSchedule(true);
  else if (tab === "my") loadMy();
  else if (tab === "alerts") loadAlerts();
  else boot();
};

function updateSub() {
  const me = state.me;
  const sub = $("#topSub");
  if (!me) return;
  if (me.token.status !== "ok") sub.textContent = me.token.status === "expired" ? "Токен ИТМО истёк" : "Токен ИТМО не подключён";
  else if (state.schedule) sub.textContent = `Обновлено ${ago(state.schedule.fetchedAt)} · ${state.schedule.weeks} нед.`;
  else sub.textContent = "Загружаю расписание…";
}
setInterval(updateSub, 30000);

async function boot() {
  try {
    state.me = await api.me();
  } catch (e) {
    const err = e as ApiError;
    $("#topSub").textContent = err.message;
    $("#dock").hidden = true;
    $("#view-schedule").innerHTML = `<div class="card empty"><h2>${err.code === "forbidden" ? "Нет доступа" : "Открой через Telegram"}</h2><p>${
      err.code === "forbidden"
        ? "Этот бот приватный."
        : err.code === "auth"
          ? "Мини-апп работает только внутри Telegram — открой его кнопкой в боте."
          : esc(err.message)
    }</p>${err.code === "auth" || err.code === "forbidden" ? "" : `<button class="soft" id="bootRetry">${icon("refresh")} Ещё раз</button>`}</div>`;
    $("#bootRetry")?.addEventListener("click", () => location.reload());
    return;
  }
  emit("me");
  updateSub();
  const initial = (location.hash.slice(1) as Tab) || "schedule";
  setTab(TABS.includes(initial) ? initial : "schedule", false);
  await loadSchedule();
  updateSub();
  // «мои записи» нужны, чтобы отмечать карточки, где ты уже записан
  if (state.me.token.status === "ok" && tab !== "my") loadMy();
}

on("schedule", updateSub);
boot().catch((e) => toast(String(e), true));
