-- Пользователи из вайтлиста. Токены ИТМО хранятся только зашифрованными (AES-GCM, см. src/worker/crypto.ts).
CREATE TABLE users (
  tg_id              INTEGER PRIMARY KEY,
  first_name         TEXT,
  username           TEXT,
  access_enc         TEXT,             -- base64(iv|ciphertext), AAD = "tg:<id>:access"
  access_exp         INTEGER,          -- unix seconds
  refresh_enc        TEXT,             -- base64(iv|ciphertext), AAD = "tg:<id>:refresh"
  refresh_exp        INTEGER,          -- unix seconds, 0 = неизвестно / offline
  token_status       TEXT NOT NULL DEFAULT 'none',  -- none | ok | expired
  token_alerted      INTEGER NOT NULL DEFAULT 0,    -- уже сообщили, что токен умер
  refresh_lock_until INTEGER NOT NULL DEFAULT 0,    -- лиза на refresh, чтобы не обновлять параллельно
  settings           TEXT NOT NULL DEFAULT '{}',    -- JSON UserSettings
  paused_until       INTEGER NOT NULL DEFAULT 0,    -- /pause: тишина до
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Правила уведомлений.
CREATE TABLE watchers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id        INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  filter       TEXT NOT NULL,           -- JSON LessonFilter
  mode         TEXT NOT NULL,           -- interval | schedule
  interval_min INTEGER,                 -- для interval
  schedule     TEXT,                    -- JSON {days:[1..7], time:"HH:MM"} (МСК) для schedule
  action       TEXT NOT NULL,           -- notify | offer | auto
  next_run_at  INTEGER NOT NULL DEFAULT 0,
  last_run_at  INTEGER,
  primed       INTEGER NOT NULL DEFAULT 0,  -- первый прогон interval только запоминает состояние
  created_at   INTEGER NOT NULL
);
CREATE INDEX watchers_due ON watchers(enabled, next_run_at);

-- Состояние занятий по правилу (для уведомлений «место появилось», а не «место есть»).
CREATE TABLE seen (
  watcher_id INTEGER NOT NULL REFERENCES watchers(id) ON DELETE CASCADE,
  lesson_key TEXT NOT NULL,
  open       INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (watcher_id, lesson_key)
);

-- «Записать при первой возможности» на конкретное занятие.
CREATE TABLE catches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id         INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  lesson_id     INTEGER NOT NULL,
  lesson_group  INTEGER,
  building_id   INTEGER NOT NULL,
  date          TEXT NOT NULL,       -- YYYY-MM-DD
  start         TEXT NOT NULL,       -- HH:MM
  finish        TEXT,
  section       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | done | failed | expired | cancelled
  result        TEXT,
  expires_at    INTEGER NOT NULL,    -- начало занятия
  last_check_at INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX catches_active ON catches(status, expires_at);

-- Отправленные «Записать вас?» — callback-кнопки ссылаются на id отсюда.
CREATE TABLE offers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id       INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  watcher_id  INTEGER,
  lesson      TEXT NOT NULL,        -- JSON Lesson на момент отправки
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | declined | expired | failed
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Журнал записей: считаем лимит автозаписей в неделю и показываем историю.
CREATE TABLE signups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id      INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  lesson_id  INTEGER NOT NULL,
  section    TEXT,
  date       TEXT,
  start      TEXT,
  source     TEXT NOT NULL,         -- manual | offer | auto | catch
  action     TEXT NOT NULL,         -- sign | unsign
  ok         INTEGER NOT NULL,
  message    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX signups_user_time ON signups(tg_id, created_at);

-- Кэш глобальных справочников ИТМО (корпуса, слоты времени) — экономим subrequests.
CREATE TABLE cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
