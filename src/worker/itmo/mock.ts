// Фейковый my.itmo.ru для локальной разработки (ENVIRONMENT=development + MOCK_ITMO=1).
// Детерминированное расписание на 4 недели, запись/отписка живут в памяти изолята.
import { addDays, mskMonday } from "../time";
import { ItmoError } from "./client";

const SECTIONS = ["Плавание", "Волейбол", "Настольный теннис", "Йога", "Баскетбол", "Фитнес", "Бадминтон", "Скалолазание", "ОФП"];
const TEACHERS = ["Иванов И.И.", "Петрова А.С.", "Сидоров К.В.", "Кузнецова М.А."];
const BUILDINGS = [
  { id: 273, value: "Кронверкский пр., 49" },
  { id: 1, value: "ул. Ломоносова, 9" },
];
const ROOMS: Record<number, string[]> = { 273: ["Кронверкский 49, зал 1", "Кронверкский 49, бассейн"], 1: ["Ломоносова 9, спортзал"] };
const SLOTS = [
  { id: 1, time_start: "08:20", time_end: "09:50" },
  { id: 2, time_start: "10:00", time_end: "11:30" },
  { id: 3, time_start: "11:40", time_end: "13:10" },
  { id: 4, time_start: "13:30", time_end: "15:00" },
  { id: 5, time_start: "15:20", time_end: "16:50" },
  { id: 6, time_start: "17:00", time_end: "18:30" },
];

const chosen = new Map<number, { section: string; date: string; slot: number; room: string; teacher: string; group: number }>();
const taken = new Map<number, number>(); // lessonId -> сколько мест заняли мы
let attempts = 5;

function lessonsFor(building: number, start: string) {
  const out: { date: string; lessons: unknown[] }[] = [];
  const base = new Date(mskMonday() + "T00:00:00Z").getTime();
  for (let d = 0; d < 7; d++) {
    const date = addDays(start, d);
    if (d === 6) continue;
    const dayIdx = Math.round((new Date(date + "T00:00:00Z").getTime() - base) / 86400000) + 14;
    const lessons = [];
    for (let k = 0; k < 4 + ((dayIdx * 7 + building) % 4); k++) {
      const id = building * 100000 + dayIdx * 100 + k;
      const g = 100 + ((k + dayIdx) % 9);
      const slot = SLOTS[(k * 2 + dayIdx) % 6]!;
      lessons.push({
        id,
        section_name: SECTIONS[(k + dayIdx) % 9],
        lesson_level: (k + dayIdx) % 9 === 8 ? 1 : 2,
        lesson_group_id: g,
        time_slot_id: slot.id,
        teacher_fio: TEACHERS[(k + dayIdx) % 4],
        room_name: ROOMS[building]![k % ROOMS[building]!.length],
        can_sign_in: { can_sign_in: (k + dayIdx) % 5 !== 0 },
        intersection: (k * 3 + dayIdx) % 7 === 0,
        // как у ИТМО: вечерние слоты по 2 ч, а само занятие короче
        date: `${date}T${slot.id >= 6 ? slot.time_start.slice(0, 3) + "10" : slot.time_start}:00+03:00`,
        date_end: `${date}T${slot.id >= 6 ? String(+slot.time_start.slice(0, 2) + 1).padStart(2, "0") + ":10" : slot.time_end}:00+03:00`,
      });
    }
    out.push({ date, lessons });
  }
  return out;
}

function limits() {
  const res: Record<string, Record<string, { available: number; limit: number }>> = {};
  const base = new Date(mskMonday() + "T00:00:00Z").getTime();
  for (const b of BUILDINGS) {
    for (let w = -1; w < 5; w++) {
      for (const day of lessonsFor(b.id, addDays(mskMonday(), 7 * w))) {
        for (const l of day.lessons as { id: number; lesson_group_id: number }[]) {
          const k = l.id % 100;
          const dayIdx = Math.floor((l.id % 100000) / 100);
          const lim = [20, 24, 30, 16][k % 4]!;
          // «плавающие» места: меняются раз в 10 минут — чтобы было что ловить
          const drift = Math.floor(Date.now() / 600000) % 3;
          const av = Math.max(0, ((dayIdx * 13 + k * 7 + b.id + drift) % (lim + 6)) - 5 - (taken.get(l.id) ?? 0));
          (res[l.lesson_group_id] ??= {})[l.id] = { available: av, limit: lim };
        }
      }
    }
  }
  void base;
  return res;
}

export async function mockRequest(method: string, path: string, body: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120));
  const url = new URL("https://x" + path);
  const p = url.pathname;
  if (method === "GET" && p === "/api/sport/sign/schedule/filters") return { building_id: BUILDINGS, sport_type_id: SECTIONS.map((s, i) => ({ id: i + 1, value: s })) };
  if (method === "GET" && p === "/api/sport/time_slots") return SLOTS;
  if (method === "GET" && p === "/api/sport/sign/schedule/limits") return limits();
  if (method === "GET" && p === "/api/sport/sign/schedule") return lessonsFor(Number(url.searchParams.get("building_id")), url.searchParams.get("date_start")!);
  if (method === "GET" && p === "/api/sport/personal/have_attempts") return { free_attempts: attempts, total_attempts: 5 };
  if (method === "GET" && p === "/api/sport/sign/chosen") {
    return [...chosen.entries()].map(([id, c]) => ({
      section_name: c.section,
      lesson_groups: [{ id: c.group, lessons: [{ id, date_start: `${c.date}T${SLOTS[c.slot - 1]!.time_start}:00+03:00`, date_end: `${c.date}T${SLOTS[c.slot - 1]!.time_end}:00+03:00`, room_name: c.room, teacher_fio: c.teacher }] }],
    }));
  }
  if (p === "/api/sport/sign/schedule/lessons") {
    const ids = body as number[];
    for (const id of ids) {
      if (method === "POST") {
        if (attempts <= 0) throw new ItmoError(400, "Нет свободных попыток записи", 1);
        const lim = Object.values(limits()).find((g) => g[id])?.[id];
        if (!lim || lim.available <= 0) throw new ItmoError(400, "На занятии нет свободных мест", 2);
        const b = Math.floor(id / 100000);
        const dayIdx = Math.floor((id % 100000) / 100);
        const date = addDays(mskMonday(), dayIdx - 14);
        const l = (lessonsFor(b, addDays(mskMonday(), Math.floor((dayIdx - 14) / 7) * 7)).flatMap((d) => d.lessons) as { id: number; section_name: string; time_slot_id: number; room_name: string; teacher_fio: string; lesson_group_id: number }[]).find((x) => x.id === id);
        chosen.set(id, { section: l?.section_name ?? "Занятие", date, slot: l?.time_slot_id ?? 1, room: l?.room_name ?? "", teacher: l?.teacher_fio ?? "", group: l?.lesson_group_id ?? 0 });
        taken.set(id, (taken.get(id) ?? 0) + 1);
        attempts--;
      } else {
        chosen.delete(id);
        taken.set(id, Math.max(0, (taken.get(id) ?? 0) - 1));
        attempts = Math.min(5, attempts + 1);
      }
    }
    return null;
  }
  throw new ItmoError(404, `mock: нет обработчика ${method} ${p}`);
}
