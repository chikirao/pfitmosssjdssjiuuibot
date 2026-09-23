-- Ловушка на конкретное занятие: 'sign' — записать самому, 'notify' — только сообщить о месте (с кнопкой «Записать»).
ALTER TABLE catches ADD COLUMN mode TEXT NOT NULL DEFAULT 'sign';
-- для 'notify': было ли место открыто на прошлой проверке (пишем только на переход «нет мест → есть»)
ALTER TABLE catches ADD COLUMN last_open INTEGER NOT NULL DEFAULT 0;
