-- Раз в 12 часов cron сверяет баллы с прошлыми и пишет, если они изменились (и напоминает о новом семестре при освобождении).
ALTER TABLE users ADD COLUMN score_last TEXT;                 -- JSON {attendance, other, semesterId}
ALTER TABLE users ADD COLUMN score_next_at INTEGER NOT NULL DEFAULT 0;
