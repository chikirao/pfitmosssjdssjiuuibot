// Типы, общие для воркера и мини-аппа.

/** Одно занятие после нормализации ответа my.itmo.ru. */
export interface Lesson {
  id: number;
  /** Уникальный ключ занятия: id бывает общим у серии, поэтому добавляем дату и время. */
  key: string;
  groupId: number | null;
  buildingId: number;
  buildingName: string;
  date: string; // YYYY-MM-DD (МСК)
  start: string; // HH:MM
  end: string; // HH:MM
  section: string;
  sportTypeId: number | null;
  freeVisit: boolean;
  typeId: number | null;
  teacher: string;
  room: string;
  comment: string;
  available: number;
  limit: number;
  canSign: boolean;
  intersection: boolean;
}

export interface Option {
  id: number;
  name: string;
}

/** Фильтр занятий: пустой массив / undefined = без ограничения. */
export interface LessonFilter {
  sections?: string[]; // точные названия секций
  query?: string; // подстрока в секции/преподавателе/зале
  buildings?: number[];
  days?: number[]; // 1 = пн … 7 = вс
  timeFrom?: string; // HH:MM, начало занятия не раньше
  timeTo?: string; // HH:MM, начало занятия не позже
  teacher?: string; // подстрока ФИО
  onlyCanSign?: boolean;
  noIntersect?: boolean;
  noFreeVisit?: boolean;
  weeks?: number; // сколько недель вперёд смотреть (1–4)
}

export type WatcherMode = "interval" | "schedule";
export type WatcherAction = "notify" | "offer" | "auto";

export interface WatcherSchedule {
  days: number[]; // 1..7, пусто = каждый день
  time: string; // HH:MM МСК
}

export interface Watcher {
  id: number;
  name: string;
  enabled: boolean;
  filter: LessonFilter;
  mode: WatcherMode;
  intervalMin: number | null;
  schedule: WatcherSchedule | null;
  action: WatcherAction;
  nextRunAt: number;
  lastRunAt: number | null;
}

export type WatcherInput = Omit<Watcher, "id" | "nextRunAt" | "lastRunAt">;

export interface Catch {
  id: number;
  lessonId: number;
  date: string;
  start: string;
  end: string | null;
  section: string;
  buildingId: number;
  status: "active" | "done" | "failed" | "expired" | "cancelled";
  result: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface UserSettings {
  /** Сколько автозаписей (auto + catch) в неделю разрешено. */
  autoWeeklyLimit: number;
  /** Можно ли тратить последнюю свободную попытку записи автоматически. */
  autoUseLastAttempt: boolean;
  /** Автозапись на занятие, пересекающееся с парами. */
  autoAllowIntersection: boolean;
  /** Тихие часы (МСК), уведомления interval-правил копятся до конца тишины. */
  quietFrom: string | null;
  quietTo: string | null;
}

export const DEFAULT_SETTINGS: UserSettings = {
  autoWeeklyLimit: 3,
  autoUseLastAttempt: false,
  autoAllowIntersection: false,
  quietFrom: "23:00",
  quietTo: "08:00",
};

export interface TokenStatus {
  status: "none" | "ok" | "expired";
  accessExp: number | null;
  refreshExp: number | null; // 0 = без срока / неизвестно
}

export interface Me {
  id: number;
  firstName: string | null;
  username: string | null;
  token: TokenStatus;
  settings: UserSettings;
  pausedUntil: number;
}

export interface ScheduleResponse {
  fetchedAt: string;
  dateStart: string;
  weeks: number;
  buildings: Option[];
  lessons: Lesson[];
}

export interface ChosenLesson {
  id: number;
  section: string;
  date: string;
  start: string;
  end: string;
  room: string;
  teacher: string;
  groupId: number | null;
}

export interface MyResponse {
  chosen: ChosenLesson[];
  attempts: { free: number | null; total: number | null };
  signups: { lessonId: number; section: string | null; date: string | null; start: string | null; source: string; action: string; ok: boolean; message: string | null; createdAt: number }[];
}

export const LIMITS = {
  maxWatchers: 10,
  maxActiveCatches: 5,
  intervalChoices: [5, 10, 15, 30, 60, 120],
  minIntervalMin: 5,
  maxWeeks: 4,
  maxAutoWeekly: 10,
} as const;
