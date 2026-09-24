# CLAUDE.md

Бот + Telegram-мини-апп для записи на физкультуру ИТМО (my.itmo.ru/sport/sign). Приватный: 2–3 пользователя из вайтлиста.
Всё крутится в **одном Cloudflare Worker**: статика мини-аппа, JSON API, webhook бота и cron.

## Команды

```bash
npm run dev              # сборка мини-аппа + wrangler dev на :8787 (локальная D1, .dev.vars)
npm run dev:web          # Vite с HMR на :5173, /api проксируется на :8787 (wrangler dev запускать отдельно)
npm run build:web        # web/ → web/dist (его раздаёт воркер как assets)
npm test                 # vitest, чистая логика (test/*.test.ts)
npm run typecheck        # tsc для воркера и для web/
npm run db:migrate:local # миграции D1 локально (remote — db:migrate:remote)
npm run keys             # сгенерировать WEBHOOK_SECRET и TOKEN_ENC_KEY
npm run deploy           # build:web + wrangler deploy
```

Локально без настоящего ИТМО: в `.dev.vars` `ENVIRONMENT=development`, `MOCK_ITMO=1`, `DEV_USER_ID=1`, `ALLOWED_USER_IDS=1`;
открыть `http://localhost:8787/?dev=1`. Токен в мок-режиме всё равно нужно «подключить»: подойдёт любой JWT с `iss=https://id.itmo.ru/auth/realms/itmo`.
Cron локально: `curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"` (путь добавлен в `run_worker_first`, иначе его перехватывает SPA-фолбэк).
BOT_TOKEN локально фейковый, чтобы ничего не уходило в настоящий Telegram: ошибки отправки только логируются.

## Структура

```
src/shared/          типы и константы, общие для воркера и мини-аппа (types.ts, tokenScript.ts)
src/worker/
  index.ts           Hono: /api/*, /tg/webhook, /tg/setup; scheduled → runScheduled
  api.ts             API мини-аппа; авторизация по Telegram initData + вайтлист
  auth/telegram.ts   проверка initData (HMAC, auth_date ≤ 24ч)
  crypto.ts          AES-256-GCM для токенов (AAD = "tg:<id>:<kind>"), HMAC, safeEqual
  itmo/client.ts     HTTP-клиент my.itmo.ru: Budget (лимит subrequests), 401 → refresh → retry
  itmo/tokens.ts     разбор ввода токена, JWT exp, refresh через Keycloak
  itmo/session.ts    хранение токенов в D1, лиза на refresh, itmoFor(), keepAlive()
  itmo/schedule.ts   эндпоинты расписания/записи + нормализация в Lesson
  itmo/mock.ts       фейковый my.itmo.ru (только ENVIRONMENT=development + MOCK_ITMO=1)
  db.ts              все SQL-запросы (D1)
  rules.ts           фильтр занятий, следующий запуск правил, валидация ввода
  signup.ts          запись/отписка + защиты автозаписи
  services.ts        общая логика бота и API
  scheduler.ts       cron: keepalive токенов → ловушки → правила
  bot/               grammY: команды, inline-кнопки, форматирование; rich.ts — rich-сообщения (таблицы, гайд с картинками)
web/                 мини-апп: Vite + TypeScript без фреймворка
  src/main.ts        табы (hash-роутинг #schedule/#my/#alerts/#profile), загрузка
  src/views/*.ts     экраны; src/ui.ts хелперы/шит/попап/fluidHover/тосты; src/tg.ts обёртка Telegram.WebApp
  src/calendar.ts    всплывающий календарь диапазона дат (пресеты + выбор «начало → конец»)
  public/_headers    CSP и прочие заголовки безопасности
migrations/          SQL для D1 (новые изменения — новым файлом 000N_*.sql, старые не править)
oldbot/              старый Python-бот на йогу (только референс, в .gitignore: там живые токены)
```

## my.itmo.ru

- Эндпоинты взяты из JS-бандла страницы `/sport/sign`. У всех заголовок `Authorization: Bearer <access>`, ответ `{error_code, error_message, result}`.
  - `GET /api/sport/sign/schedule/filters` — корпуса `building_id[{id,value}]`, виды спорта
  - `GET /api/sport/sign/schedule?building_id=&date_start=&date_end=` — дни → lessons
  - `GET /api/sport/sign/schedule/limits` — `{[lesson_group_id]: {[lesson_id]: {available, limit}}}`
  - `GET /api/sport/time_slots`, `GET /api/sport/sign/chosen`, `GET /api/sport/personal/have_attempts`
  - `GET /api/sport/semesters/current` → `{id, …}`; `GET /api/sport/personal/score?semester_id=` → `{sum: {attendances, other}, attendances: [...]}`.
    Круг баллов на сайте — шкала до 100: сначала посещения, за ними доп. баллы (засчитываются при посещениях ≥ 60)
  - `POST /api/sport/sign/schedule/lessons` body `[lessonId]` — запись; `DELETE` с тем же body — отписка
- **CORS закрыт**: из браузера на чужом домене ходить нельзя, только из воркера.
- Мини-апп запрашивает `/api/schedule?from=&to=` (включительно, ≤ `LIMITS.maxRangeDays`, не дальше `maxAheadDays`; проверка — `parseRange`).
  У ИТМО спрашиваем кусками пн+7 дней (`weekStarts`), как сам сайт, и обрезаем по диапазону. Правила по-прежнему смотрят «N недель вперёд» (`rangeForWeeks`).
- Время занятия — из `date`/`date_end` (ISO), как в карточке на сайте. `time_slot_id` — только ячейка сетки
  (вечерние слоты по 2 ч: занятие 19:10–20:10 стоит в слоте 19:00–21:00); слот — фолбэк и часть `lessonKey`.
- `lesson.id` бывает общим у серии занятий, поэтому ключ занятия — `date|id|start|group` (`lessonKey`).
- «Свободное посещение» (`lesson_level === 1`): места берутся по `other_lessons`.
- Всё время — **МСК (UTC+3)**. Воркер работает в UTC; для дат только хелперы из `time.ts` (web: `ui.ts` `mskNow/TODAY`).

## Токены и безопасность (не ослаблять)

- Access-токен живёт **30 минут**; refresh — пока жива SSO-сессия ITMO ID. Refresh: `POST https://id.itmo.ru/auth/realms/itmo/protocol/openid-connect/token`,
  `grant_type=refresh_token`, `client_id=student-personal-cabinet`. Cron обновляет access за 5 минут до истечения, это же держит сессию живой.
  Когда refresh умер (`invalid_grant`), ставим `token_status='expired'` и один раз пишем пользователю.
- Refresh обменивается под лизой `users.refresh_lock_until`: Keycloak может ротировать refresh-токены, параллельный обмен убил бы сессию.
- Токены в D1 хранятся только зашифрованными (`TOKEN_ENC_KEY`), никогда не логируются и не отдаются клиенту (API отдаёт только статус и сроки).
- Сообщение с токеном бот сразу удаляет из чата.
- Любой вход проверяется: мини-апп через `verifyInitData`, бот через заголовок `X-Telegram-Bot-Api-Secret-Token`; потом `isAllowed` (вайтлист `ALLOWED_USER_IDS`).
  Бот работает только в личке. `DEV_USER_ID`/`X-Dev-User` работают только при `ENVIRONMENT=development`.
- Все ресурсы в D1 выбираются с `WHERE tg_id = ?` текущего пользователя.
- Кнопки «Записать» ссылаются на `offers.id`, а не несут данные занятия; `takeOffer` атомарно переводит `pending → accepted`, поэтому двойное нажатие не запишет дважды.

## Планировщик и лимиты

- Cron раз в минуту. Бюджет внешних fetch на запуск — `SUBREQUEST_BUDGET` (40; у free-плана лимит 50). Не влезло — доделается в следующую минуту.
  Справочники (корпуса, слоты) кэшируются в таблице `cache` на 12 ч.
- Правила: `interval` (5/10/15/30/60/120 мин, уведомление на переход «закрыто → открыто»; первый прогон только сообщает текущее)
  или `schedule` (сводка в ЧЧ:ММ МСК по дням). Действие: `notify` | `offer` («Записать вас?») | `auto` (только с interval).
- Ловушка (`catches`) — конкретное занятие, проверка каждую минуту (только чтение limits — записи ИТМО не тратит), снимается при начале занятия.
  Повторяет попытки только при отказе «нет мест» (error_code 9); любой другой отказ ИТМО снимает ловушку с объяснением.
  Режим `catches.mode`: `sign` — записать самому; `notify` — только сообщить на переходе «мест нет → есть» (`last_open`),
  с кнопкой `cs:<id>` «Записать»; в тишину/паузу ждёт и сообщает после.
- Защиты автозаписи (`signup.ts`): своего лимита нет — повторяем ограничения ИТМО: ≤2 записей в неделю (по `/sign/chosen`) и остаток на семестр; последнюю запись семестра не тратить (`have_attempts`: total — лимит ИТМО на семестр, free — остаток); не записывать при пересечении с парами
  и с уже выбранными занятиями. Всё настраивается в «Профиле». Тихие часы и `/pause` глушат уведомления; автозапись при этом работает молча.
- Баллы: раз в 12 ч (`users.score_next_at`) cron сверяет `/personal/score` со снимком `users.score_last` и пишет «📈 +N»; первый прогон только запоминает.
  В тишину/паузу откладывает на 30 мин, не теряя новость. Смена `semesterId` при освобождении — напоминание оформить теор. зачёт и сброс чек-листа.
- Освобождение (`settings.exempt`): мини-апп прячет «Расписание» и «Уведомления», в «Моих» — баллы и чек-лист `THEORY_STEPS` (`settings.theory`);
  cron пропускает правила и ловушки такого пользователя. Саму заявку на теор. зачёт бот не подаёт — её делают на my.itmo.
- Максимум 10 правил и 5 активных ловушек на пользователя.

## Стиль кода

- TypeScript strict, ES-модули, без лишних зависимостей: воркер — hono + grammy, фронт — ничего, кроме Vite.
- Все пользовательские тексты на русском. В боте parse_mode HTML, всё динамическое экранируется через `esc()`.
  Ответы на команды — rich-сообщения (Bot API 10.1+, `bot/rich.ts`: заголовки, таблицы, картинки, `<details>`) через `replyRich` с обычным HTML-фолбэком;
  разрешены только теги из «Rich HTML style» (проверяет тест). Кнопки с последствиями — `.style("danger")`, основное действие — `"success"`/`"primary"`.
  Картинки /guide — `web/public/guide/step-N.png`, рисуются из `assets/guide/guide.html`: `npm run guide:shots`. Новая команда → добавить в `setMyCommands` (`index.ts`) и перезапустить `/tg/setup`.
- Фронт: DOM-строки через шаблоны + `esc()`; никаких inline-обработчиков (их режет CSP); клики — делегированием.
- Дизайн: мягкие карточки (градиентная обводка, `--shadow-card`), кнопки `.btn-*` с эффектом нажатия из Fluid Functionalism
  (внутренний слой `inset:1px` + схлопывающийся spread 180 мс `cubic-bezier(.23,1,.32,1)`), `.soft` — «Reject»-кнопка из макета.
  Попапы (`openPopover`) — как popup из Fluid Functionalism: растут от якоря, сдвиг 4px, вход 160 мс `--ease`, выход 120 мс; тень `--shadow-pop` (лестница shadow-6).
  Списки/сетки в попапах — `fluidHover` (одна скользящая подсветка). Диапазон в календаре — сливающаяся полоса (merge/split).
  Цвета только через CSS-переменные; тёмная тема — `:root[data-theme=dark]` (ставится из Telegram `colorScheme`).
- Производительность на телефоне: никаких `backdrop-filter`/`mask-image` на мобильных, списки порциями по 40, анимация только у первых ~12 карточек,
  `content-visibility:auto` на днях, поиск с debounce.
- Новый SQL — только в `db.ts`; схему меняем новой миграцией.
- После изменений: `npm test && npm run typecheck && npm run build:web`.
