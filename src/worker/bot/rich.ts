// Rich-сообщения Telegram (Bot API 10.1+): заголовки, таблицы, картинки, сворачиваемые блоки.
// Если Telegram не принял rich-разметку — отправляем обычное HTML-сообщение (fallback), чтобы ответ не терялся.
import type { Context } from "grammy";
import type { InlineKeyboard } from "grammy";
import type { ChosenLesson, Lesson, Score, UserSettings } from "../../shared/types";
import type { CatchWithOwner } from "../db";
import { esc, humanDate, plural } from "./format";

type Reply = { reply_markup?: InlineKeyboard };

export async function replyRich(ctx: Context, html: string, fallback: string, other: Reply = {}) {
  try {
    return await ctx.replyWithRichMessage({ html, skip_entity_detection: false }, other);
  } catch (e) {
    console.warn("rich message rejected, fallback", (e as Error).message);
    return ctx.reply(fallback, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...other });
  }
}

const COMMANDS: [string, string][] = [
  ["/free <i>секция</i>", "что свободно в ближайшие 2 недели"],
  ["/my", "мои записи и баллы, отписка"],
  ["/watch <i>секция</i>", "новое правило уведомлений"],
  ["/watches", "мои правила"],
  ["/catches", "отслеживаемые занятия: 🎯 запишу сам, 🔔 сообщу о месте"],
  ["/guide", "как достать токен ИТМО (с картинками)"],
  ["/token", "статус токена, заменить токен"],
  ["/pause <i>часы</i> · /resume", "тишина и обратно"],
  ["/settings", "лимиты автозаписи и тихие часы"],
  ["/forget", "удалить все мои данные"],
];

export function helpHtml(tokenLine: string) {
  return `<h2>Физра ИТМО</h2>
<p>Свободные места, запись и уведомления о физкультуре — прямо в чате. Всё то же самое есть в мини-аппе: кнопка «Открыть» слева от поля ввода.</p>
<blockquote>${tokenLine}</blockquote>
<h3>Команды</h3>
<table striped compact><tr><th>Команда</th><th>Что делает</th></tr>
${COMMANDS.map(([c, d]) => `<tr><td>${c}</td><td>${d}</td></tr>`).join("\n")}
</table>
<footer>Токен можно просто прислать сообщением — я его узнаю и сразу удалю из чата.</footer>`;
}

export function helpFallback(tokenLine: string) {
  return `<b>Физра ИТМО</b> — свободные места и запись на секции.\n\n${COMMANDS.map(([c, d]) => `${c} — ${d}`).join("\n")}\n\n${tokenLine}`;
}

// ---------- инструкция по токену ----------

const STEPS = [
  { img: 1, cap: "Открой my.itmo.ru/sport/sign на компьютере и войди в аккаунт ИТМО" },
  { img: 2, cap: "Нажми F12 (или Ctrl+Shift+J, на Mac ⌥⌘J) и открой вкладку Console" },
  { img: 3, cap: "Вставь скрипт отсюда (он ниже) и нажми Enter. Если Chrome не даёт вставить — сначала напечатай allow pasting" },
  { img: 4, cap: "В консоли появится «✓ Скопировано» — пришли скопированное мне. Сообщение с токеном я сразу удалю" },
];

export function guideHtml(appUrl: string, status: string, script: string) {
  const fig = (s: (typeof STEPS)[number]) => `<figure><img src="${esc(appUrl)}/guide/step-${s.img}.png"/><figcaption>${s.img}. ${esc(s.cap)}</figcaption></figure>`;
  return `<h2>Как подключить токен ИТМО</h2>
<p>Токен — это пропуск бота в твой my.itmo.ru: с ним я вижу расписание и записываю. Нужен компьютер — консоль браузера есть только там. Займёт минуту.</p>
<blockquote>${status}</blockquote>
${fig(STEPS[0]!)}
${fig(STEPS[1]!)}
${fig(STEPS[2]!)}
<h3>Скрипт для консоли</h3>
<p>Нажми на блок — скопируется целиком:</p>
<pre><code class="language-javascript">${esc(script)}</code></pre>
${fig(STEPS[3]!)}
<details><summary>Не получается?</summary>
<ul>
<li><b>Chrome не даёт вставить</b> — напечатай в консоли <code>allow pasting</code>, нажми Enter и вставь ещё раз.</li>
<li><b>Скрипт пишет «refresh-токен не найден»</b> — выйди из my.itmo.ru, войди заново и запусти скрипт ещё раз.</li>
<li><b>С телефона</b> не получится: нужна консоль браузера на компьютере.</li>
</ul>
</details>
<details><summary>Это безопасно?</summary>
<ul>
<li>Токен храню только зашифрованным, никому не показываю и не отдаю в мини-апп.</li>
<li>Сообщение с токеном удаляю сразу, как прочитал.</li>
<li>Сам токен живёт 30 минут — я продлеваю его, пока жива сессия ИТМО. Закончится — напишу. Удалить всё: /forget.</li>
</ul>
</details>`;
}

export function guideFallback(status: string, script: string) {
  return `<b>Как добавить токен ИТМО</b>\n${status}\n\n${STEPS.map((s) => `${s.img}. ${esc(s.cap)}`).join("\n")}\n\n<code>${esc(script)}</code>`;
}

// ---------- свободные места ----------

const seatsCell = (l: Lesson) => `<b>${l.available}</b>/${l.limit}`;

export function freeHtml(lessons: Lesson[], total: number, q?: string) {
  const byDay = new Map<string, Lesson[]>();
  for (const l of lessons) byDay.set(l.date, [...(byDay.get(l.date) ?? []), l]);
  const days = [...byDay]
    .map(
      ([d, ls]) => `<h4>${esc(humanDate(d))}</h4>
<table striped compact><tr><th>Время</th><th>Секция</th><th>Где</th><th align="center">🪑</th></tr>
${ls
  .map(
    (l) =>
      `<tr><td>${esc(l.start)}–${esc(l.end)}</td><td><b>${esc(l.section)}</b>${l.intersection ? " ⚠️" : ""}${l.teacher ? ` · <i>${esc(l.teacher)}</i>` : ""}</td><td>${esc(l.room || l.buildingName)}</td><td align="center">${seatsCell(l)}</td></tr>`,
  )
  .join("\n")}
</table>`,
    )
    .join("\n");
  const more = total > lessons.length ? `<p>…и ещё ${total - lessons.length}. Полный список с фильтрами — в мини-аппе.</p>` : "";
  return `<h3>Свободно${q ? ` по «${esc(q)}»` : ""}: ${total} ${plural(total, "занятие", "занятия", "занятий")}</h3>
${days}
${more}
<footer>Нажми кнопку ниже, чтобы записаться. ⚠️ — пересекается с парами.</footer>`;
}

// ---------- мои записи ----------

export function myHtml(future: ChosenLesson[], attempts: { free: number | null; total: number | null }, score: Score) {
  const scoreLine =
    score.attendance !== null
      ? `<p>Баллы: <b>${Math.round(score.attendance + (score.other ?? 0))}</b> из 100 — ${Math.round(score.attendance)} за посещения, ${Math.round(score.other ?? 0)} доп.${score.semester ? ` <i>(${esc(score.semester)})</i>` : ""}</p>`
      : "";
  const att = attempts.free !== null ? `<p>Осталось записей в семестре: <b>${attempts.free}</b>${attempts.total !== null ? ` из ${attempts.total}` : ""} (и не больше 2 в неделю)</p>` : "";
  const table = future.length
    ? `<table striped compact><tr><th>Когда</th><th>Секция</th><th>Где</th></tr>
${future.map((c) => `<tr><td>${esc(humanDate(c.date))}, ${esc(c.start)}${c.end ? `–${esc(c.end)}` : ""}</td><td><b>${esc(c.section)}</b></td><td>${esc(c.room)}</td></tr>`).join("\n")}
</table>`
    : `<p>Предстоящих записей нет.</p>`;
  return `<h3>Мои записи</h3>
${table}
${scoreLine}${att}
${future.length ? "<footer>Отписаться — кнопками ниже.</footer>" : ""}`;
}

// ---------- ловушки ----------

export function catchesHtml(cs: Pick<CatchWithOwner, "mode" | "section" | "date" | "start" | "end">[]) {
  return `<h3>Слежу за занятиями</h3>
<p>Проверяю места раз в минуту, пока занятие не началось.</p>
<table striped compact><tr><th>Режим</th><th>Занятие</th><th>Когда</th></tr>
${cs.map((c) => `<tr><td>${c.mode === "notify" ? "🔔 сообщу" : "🎯 запишу"}</td><td><b>${esc(c.section)}</b></td><td>${esc(humanDate(c.date))}, ${esc(c.start)}${c.end ? `–${esc(c.end)}` : ""}</td></tr>`).join("\n")}
</table>
<footer>Отменить — кнопками ниже.</footer>`;
}

// ---------- настройки ----------

export function settingsHtml(s: UserSettings, pausedUntil: number, now: number) {
  const yes = (b: boolean) => (b ? "✅ да" : "— нет");
  const rows: [string, string][] = [
    ["Освобождение (теор. зачёт)", yes(s.exempt)],
    ["Тратить последнюю запись семестра", yes(s.autoUseLastAttempt)],
    ["Автозапись при пересечении с парами", yes(s.autoAllowIntersection)],
    ["Тихие часы", s.quietFrom && s.quietTo ? `${esc(s.quietFrom)}–${esc(s.quietTo)}` : "выкл"],
    ["Пауза уведомлений", pausedUntil > now ? `до ${new Date((pausedUntil + 3 * 3600) * 1000).toISOString().slice(11, 16)} МСК` : "нет"],
  ];
  return `<h3>Настройки</h3>
<table striped compact>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
<footer>Менять — в мини-аппе, вкладка «Профиль».</footer>`;
}
