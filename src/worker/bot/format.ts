import type { ChosenLesson, Lesson } from "../../shared/types";
import { isoWeekday } from "../time";

export const esc = (s: string | number | null | undefined) =>
  String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

const WD = ["", "пн", "вт", "ср", "чт", "пт", "сб", "вс"];
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function humanDate(ymd: string): string {
  return `${WD[isoWeekday(ymd)]}, ${Number(ymd.slice(8, 10))} ${MONTHS[Number(ymd.slice(5, 7)) - 1]}`;
}

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many;
}

/** Одна строка-заголовок + детали. */
export function lessonBlock(l: Lesson): string {
  const seats = `${l.available}/${l.limit}`;
  const tags = [l.freeVisit ? "свободное посещение" : "", l.intersection ? "⚠️ пересечение с парами" : "", l.canSign ? "" : "⛔ запись закрыта"].filter(Boolean);
  return [
    `<b>${esc(l.section)}</b> — ${humanDate(l.date)}, ${esc(l.start)}–${esc(l.end)}`,
    `🪑 ${seats} · ${esc(l.teacher || "преподаватель не указан")}`,
    `📍 ${esc(l.room || l.buildingName)}`,
    tags.length ? tags.join(" · ") : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function lessonLine(l: Lesson, i?: number): string {
  const n = i !== undefined ? `${i + 1}. ` : "";
  return `${n}<b>${esc(l.section)}</b> ${humanDate(l.date)} ${esc(l.start)} · 🪑${l.available}/${l.limit}${l.intersection ? " ⚠️" : ""}\n    ${esc(l.teacher)}${l.room ? ` · ${esc(l.room)}` : ""}`;
}

export function chosenLine(c: ChosenLesson, i: number): string {
  return `${i + 1}. <b>${esc(c.section)}</b> — ${humanDate(c.date)}, ${esc(c.start)}${c.end ? `–${esc(c.end)}` : ""}${c.room ? `\n    📍 ${esc(c.room)}` : ""}`;
}

/** Короткое название кнопки (Telegram обрезает длинные). */
export function buttonLabel(l: Pick<Lesson, "section" | "date" | "start">, prefix = ""): string {
  const name = l.section.length > 18 ? l.section.slice(0, 17) + "…" : l.section;
  return `${prefix}${name} ${WD[isoWeekday(l.date)]} ${l.start}`;
}

export { TOKEN_SCRIPT } from "../../shared/tokenScript";
