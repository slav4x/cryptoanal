# CryptoAnal

CryptoAnal — dashboard-first платформа для исследования, проверки, запуска и анализа
криптоторговых стратегий. Private dashboard защищён database-backed сессиями, а данные
разделены membership-based workspaces. Полный план находится в [docs/rebuild](docs/rebuild/README.md).

Актуальная [независимая проверка движка от 14 октября 2026](docs/engine-verification-2026-10-14.md)
содержит подтверждённые исправления, сверку сделок и ограничения исторической проверки.
Следующие девять направлений и порядок изменений — в
[списке задач по качеству сделок](docs/trade-quality-tasks-2026-10-14.md).

## Структура

- `apps/dashboard` — React/Vite dashboard;
- `apps/api` — Fastify API;
- `apps/worker` — execution и background jobs;
- `packages/ui` — shadcn-compatible компоненты, Radix Select и design tokens;
- `packages/contracts` — Zod schemas и общие DTO;
- `packages/application` — use cases, context и ports;
- `packages/persistence` — Prisma client и repositories;
- `packages/config` — server-side environment config;
- `prisma` — чистая схема и seed development workspace.

Визуальное направление перенесено из согласованных макетов `crypto-trade/design` в
semantic tokens `packages/ui/src/styles/globals.css`. Feature-страницы используют эти
токены и shadcn-compatible primitives без собственной темы. Поля форм используют единую
desktop-геометрию, а выпадающие списки собраны на Radix Select с общими состояниями
focus, disabled и keyboard navigation. Основные контролы используют текст 13 px,
компактные варианты — 12 px; длинное выбранное значение Select остаётся в одну строку
и обрезается многоточием.

## Текущий статус

Dashboard, runtime/validation, analytics, migration и backup-контуры завершены. В P1 уже
работают database users, session auth, CSRF, membership isolation, создание/переключение
workspaces, приглашения, управление участниками, encrypted exchange connections, проверка
Bybit credentials, deployment binding, periodic verification, управление пользовательскими
сессиями, смена и восстановление пароля, multi-workspace worker, а также четыре независимых
семейства сигналов: EMA crossover, breakout, mean-reversion и momentum. Следующий
продуктовый блок — оставшийся client hardening. Landing остаётся последним этапом.

Уточнения закрытых свечей помечаются временем изменения. Перед следующим шагом
индикаторов runtime восстанавливает их от закреплённого validation snapshot до
прежней границы, затем обрабатывает новые свечи. Уже обработанные торговые события
повторно не исполняются; неполная история или недоступный snapshot блокируют пересчёт.

В validation 0.11.0 и candle replay 1.5.0 защитный выход выбирает более близкий
из SL и trailing: больший уровень для long, меньший для short. Выход, достигнутый
на open, проверяется до экстремумов всей свечи; gap через защиту закрывает по open.
Если TP и защитный уровень затронуты только внутри свечи и порядок неизвестен,
используется консервативный защитный выход. Take-profit исполняется по заданной цели,
включая благоприятный gap. Quote/recovery используют одинаковый выбор защитного уровня. Для лимитного
входа внутри свечи неизвестный favorable extreme до fill не создаёт TP, break-even
или trailing: остаются неблагоприятный экстремум после пересечения лимита и
подтверждённая цена close. Opening fill сохраняет полную свечу; replay отмечает
неизвестное время intrabar fill.

Validation 0.12.0 / candle replay 1.6.0 дополнительно проверяют цену close после
переноса защиты по подтверждённому favorable extreme: пересечённый новый trailing
или безубыток закрывает позицию в этой свече. Неизвестное intrabar касание нового
уровня при close вне защиты не выдаётся за подтверждённый выход. Защита имеет
приоритет над сигнальным выходом на той же цене close. Сигнальные выходы отмечаются
временем закрытия свечи, а не её начала.

Execution 0.4.0 сохраняет расчётную точность цены и количества в settlement;
округление итоговых сумм остаётся до восьми знаков. При закрытии из price journal
последние SL/trailing/bestPrice и progress сохраняются вместе со сделкой. Recovery
восстанавливает защитные касания; сигнальный выход исполняется первым доступным
журнальным quote после finality, с ценой этого quote. Запись сигнального выхода
задним числом по цене закрытия свечи исключена. Новые входы сохраняют ID и stream
котировки, worker heartbeat — фактические версии execution/validation.
Конфигурация отклоняет расстояние SL long или TP short от 100%: соответствующая
цена стала бы нулевой или отрицательной. Проценты для противоположной стороны
сохраняют прежние допустимые границы.

Ценовая история новых DRY_RUN позиций сохраняется от входа до закрытия и ещё
`RUNTIME_TRACE_RETENTION_DAYS=30` дней. Горячий журнал
`RUNTIME_EVENT_RETENTION_HOURS=24` дополняется общим сжатым архивом по символам;
непрочитанные события остаются в горячем журнале. Архивация и удаление атомарны
и выполняются отдельно от приёма цен. Snapshot стратегии и политики, переносы
защиты, исходные сигналы с finality и минуты recovery позволяют проверить сделку:

```bash
pnpm runtime:replay-trace <workspace-id> <position-id>
pnpm runtime:ledger
```

Replay только читает данные, проверяет контрольные суммы, количество событий,
защитные уровни и денежный результат; возвращает ошибку при расхождении или
неполноте. Для ранее открытых позиций начало истории обозначено как текущая
контрольная точка. Recovery по исходным OHLC отдельно указывает неизвестный
порядок внутриминутных цен. Новые publicTrade события дополнены bid/ask и объёмами
лучшего уровня стакана, стороной/объёмом сделки и исходным временем получения.
Эти данные сохраняются в том же архиве. `pnpm runtime:market-data` проверяет покрытие,
возраст стакана и спред на последних 20 000 событиях. Новые входы execution 0.7.0
используют этот стакан; ликвидность выходов остаётся частью
[рабочего списка](docs/trade-quality-tasks-2026-10-14.md).
[Сбор данных и проверка](docs/execution-market-data-2026-10-15.md).
Funding пока записан как выключенный.

### Исполнение новых DRY_RUN входов

Сигнал, отправка заявки и fill разделены. Сначала сохраняется заявка с фактическим
временем отправки; исполнить её могут только последующие события того же потока.
Market моделируется как IOC по встречному лучшему уровню, limit — как PostOnly:
пересекающий стакан лимит отменяется, одного касания цены недостаточно для fill.
Maker fill требует последующей обычной сделки встречного taker строго за лимитом;
участвует не более 10% её объёма. Это допущение DRY_RUN очереди, не подтверждённый
биржей fill. Block/RPI сделки не подтверждают maker исполнение.

Первый полный или частичный fill завершает заявку; остаток отменяется. SL/TP и
trailing защищают фактически исполненное количество. Пересечённый в событии входа
стоп исполняется сразу в той же транзакции. Ни повтор события, ни конкурентный вход
одного аккаунта не используют уже распределённый объём повторно. IOC дополнительно
вычитает обычные публичные сделки, потребившие тот же снимок встречного уровня.
Заявки отменяются по TTL, pause/stop и смене потока; отмена по времени работает
даже без следующего события рынка.

Ограничения задаются в `.env`: `RUNTIME_ENTRY_MAX_SPREAD_BPS=20`,
`RUNTIME_ENTRY_MAX_SLIPPAGE_BPS=50`, `RUNTIME_ENTRY_BOOK_MAX_AGE_MS=1000`,
`RUNTIME_ENTRY_MAKER_PARTICIPATION_BPS=1000`. Policy и параметры инструмента
фиксируются при отправке заявки. Комиссия соответствует maker/taker, дополнительное
фиксированное проскальзывание поверх цены входного fill не начисляется.
`runtime:ledger` и `runtime:replay-trace` проверяют сохранённые доказательства входа.
Требуется миграция `20261015030000_entry_liquidity_execution`.

Старые позиции и сделки сохраняют прежние правила. Выходы пока используют прежний
расчёт проскальзывания; validation 0.13.0 и candle replay 1.7.0 сохраняют модель OHLC.
Они ещё не эквивалентны новым runtime входам. Ликвидность и частичные выходы
доделываются следующим этапом пункта 3.
[Правила, проверка и ограничения](docs/entry-liquidity-2026-10-15.md).

### Источник SL/TP и цена защитного выхода

Execution 0.7.0 закрепляет exit policy в новой входной заявке, позиции и trace.
`RUNTIME_EXIT_TRIGGER_SOURCE=LastPrice` — единственный поддерживаемый источник:
publicTrade. SL, trailing и TP используют его явно; MarkPrice/IndexPrice и неизвестный
источник не подставляются вместо него. Старые позиции и уже отправленные до
обновления заявки сохраняют прежний контракт.

SL и TP в новом контракте — market выходы с taker-комиссией. Уровень TP задаёт
условие срабатывания; при скачке через него ценовой ориентир выхода берётся из
конкретного publicTrade, а не из самого уровня TP. Затем применяется прежнее
фиксированное проскальзывание. Это ещё не исполнение выхода по стакану.
Журнал и replay проверяют исходное событие, уровни, цену, комиссию и checksum
нового защитного fill. При OHLC recovery неизвестное исполнение не выдаётся за
точный SL/TP: применяется recovery-exit по первой известной котировке с обозначенной
неопределённостью. Требуется миграция `20261015040000_exit_trigger_policy`.
[Проверка и границы модели](docs/exit-trigger-policy-2026-10-15.md).

### Защита прибыли DRY_RUN позиций

Начиная с execution 0.5.0 новые позиции нормализуются по закреплённым `tickSize`/`qtyStep`,
минимальным и максимальным размерам и диапазону цены. Количество округляется вниз
с повторной проверкой риска и издержек; отсутствие обязательных данных или возраст
metadata больше часа блокирует вход. Snapshot ограничений сохраняется с позицией.
SL, TP, безубыток и trailing остаются на допустимых шагах; R считается от фактического
начального стопа после округления. Старые позиции продолжают работать по прежним правилам.

Validation 0.13.0 и candle replay 1.7.0 используют те же расчёты. Для нового validation
снимок фиксируется один раз и сохраняется при retry. В интерфейсе явно указано,
что применение этого снимка к прошлому периоду является сценарным допущением.
[Подробные правила и результаты](docs/instrument-rules-2026-10-15.md).

`RUNTIME_PROFIT_PROTECTION_ENABLED_AT` включает отдельную runtime защиту каждой
позиции с указанного UTC времени. По умолчанию дата не задана и защита выключена.
`RUNTIME_PROFIT_BREAK_EVEN_ACTIVATION_R=0.5` переносит стоп в безубыток с учётом
комиссий и проскальзывания; `RUNTIME_PROFIT_TRAILING_ACTIVATION_R=1` включает trailing,
`RUNTIME_PROFIT_TRAILING_DISTANCE_R=0.5` задаёт расстояние в исходном риске позиции.
R — расстояние от входа до исходного стопа, независимо от последующих переносов.

Применяется к открытым и будущим DRY_RUN позициям. Отдельный durable checkpoint
отслеживает только цены после включения; прежний исторический максимум не активирует
новую защиту. Уровни сохраняются атомарно с price progress и никогда не ослабляются;
restart сохраняет максимум, смена policy начинает его заново. Отключение policy
прекращает новые переносы, но сохраняет уже установленные защитные уровни.
При разрыве stream действует прежний консервативный recovery; неизвестные максимумы
не создают новую защиту. Gap может исполнить стоп хуже его уровня.

Это дополнительная runtime политика: исходные версии стратегий и исторические
validation не изменяются, прежний baseline не подтверждает результаты с этой защитой.
Общий take-profit портфеля не включается. Активация отражается в audit, policy/state —
в factors закрытия. После изменения environment пересоздайте API и worker.

## Требования

- Node.js 22.18+;
- pnpm 10+;
- Docker с Compose либо PostgreSQL 17+.

## Постоянный локальный запуск через Docker

После заполнения `.env` весь контур запускается одной командой:

```bash
docker compose up -d --build
```

Compose сохраняет PostgreSQL в именованном volume, автоматически применяет миграции перед
стартом API и перезапускает сервисы после сбоя или рестарта Docker. Проверка состояния и
просмотр логов:

```bash
docker compose ps
docker compose logs -f api worker
```

Остановка приложений без удаления базы:

```bash
docker compose stop api worker dashboard
```

## Запуск для разработки без контейнеров приложений

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
CRYPTOANAL_NEW_USER_PASSWORD='use-a-long-local-password' \
  pnpm auth:create-user --email owner@example.com --name 'Owner' --workspace development
pnpm dev
```

В этом режиме PostgreSQL работает в Docker, а API, worker и Vite — как локальные процессы.

Импорт shared research-набора из Git без дубликатов:

```bash
pnpm strategies:import-shared --workspace development
```

Чтобы сразу поставить локальные backtest за период, зафиксированный в наборе:

```bash
pnpm strategies:import-shared --workspace development --queue-validations
```

Чужие метрики хранятся только как референс и не подменяют результаты локальной валидации.
После успешного локального backtest прошедшие стратегии можно запустить в изолированных
dry-run аккаунтах:

```bash
pnpm strategies:launch-shared --workspace development
```

Годовой исследовательский backtest всех запущенных стратегий за 01.09.2025–31.08.2026:

```bash
pnpm exec tsx scripts/annual-backtest.ts
```

Скрипт выводит JSON; [сводка по 34 стратегиям](docs/annual-backtest-2025-2026.md) содержит
метод, все результаты и хеши исходных рядов. Запущенные dry-run стратегии не меняются.
При необходимости host-проxy задаётся через `ANNUAL_BACKTEST_PROXY_URL`.

Чтобы поставить тот же годовой период в штатную очередь платформы и видеть отчёты на
`/validation`, запустите:

```bash
pnpm validations:queue-annual
```

Команда идемпотентна для текущих версий запущенных стратегий. Backtest выполняется worker'ом,
сохраняет датасет, метрики и сделки; статус стратегии и её dry-run deployment не меняются.
Повторные проверки запущенной стратегии также доступны в интерфейсе «Проверки».

Адреса:

- dashboard: `http://localhost:15173`;
- API: `http://localhost:13100`;
- health: `http://localhost:13100/health`;
- PostgreSQL на host: `127.0.0.1:15432`.

Host-порты задаются в `.env` через `DASHBOARD_HOST_PORT`, `API_HOST_PORT` и
`POSTGRES_HOST_PORT`; внутренние порты Docker-сети не меняются.

Основные рабочие маршруты:

- `/` — обзор с интерактивным графиком капитала; по умолчанию 24 часа, доступны 7 и 30 дней;
- `/markets` — workspace-scoped список инструментов, watchlist и управление доступными
  Bybit-парами через активное биржевое подключение;
- `/markets/:symbol` — интерактивные реальные свечи, торговые отметки и уровни открытых
  позиций, multi-select фильтр стратегий, техническая сводка и табличный торговый контекст
  пары;
- `/trades` — открытые позиции и история завершённых сделок;
- `/trades/:tradeId` — результат сделки, runtime-контекст, ордера и fills;
- `/strategies` — каталог стратегий, версий, validation и deployment states;
- `/strategies/new` — секционный редактор, multi-select пар из Market Universe и создание
  черновика с immutable v1;
- `/strategies/:strategyId` — workspace стратегии с обзором, конфигурацией и историей версий;
- `/strategies/:strategyId/versions/new` — создание новой версии на основе последней;
  удалённые из Market Universe пары остаются в старой immutable-версии, но должны быть
  исключены перед сохранением новой;
- `/validation` — постановка backtest/walk-forward runs и состояние durable очереди;
- `/validation/:validationRunId` — полный отчёт запуска: метрики, equity/drawdown, gates,
  пары, сделки и provenance;
- `/validation/compare` — сравнение 2–4 завершённых запусков;
- `/runtime` — dry-run deployments, execution runs и подтверждаемые runtime-команды.
- `/analytics` — performance, equity, drawdown, месячный PnL-календарь с навигацией и
  разрезы результатов;
  по умолчанию выбран период 24 часа, доступны 7 и 30 дней.
- `/analytics/health` — operational health, watchdog incidents и validation drift.
- `/activity` — лента OPEN/CLOSE/HOLD/SKIP/ERROR с причинами и факторами решения.
- `/journal` — исследовательские записи, предметные связи и review sessions.
- `/playbooks` — библиотека сетапов, правил, условий инвалидации и связанных примеров.
- `/system/logs` — технические события сервисов с фильтрами, cursor pagination и redaction.
- `/settings` — секционные настройки workspace: рабочее пространство, доступ и безопасность,
  торговая инфраструктура, данные и система; включает runtime safety, интеграции и JSON-экспорт.
- `/invite/:token` — принятие одноразового приглашения существующим или новым пользователем.
- `/recovery/:token` — установка нового пароля по одноразовой recovery-ссылке.

Реализованный private API:

- `GET /api/v1/auth/session`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`;
- `GET /api/v1/auth/sessions` и `DELETE .../:sessionId` — просмотр и отзыв активных устройств;
- `POST /api/v1/auth/password` — смена пароля с отзывом остальных сессий;
- `GET`/`POST /api/v1/auth/recovery/:token` — проверка и применение recovery token;
- `POST /api/v1/auth/workspace` — membership-checked смена активного workspace;
- `POST /api/v1/workspaces` — создание изолированного workspace и owner membership;
- `GET /api/v1/workspaces/:workspaceId/access` — участники и ожидающие приглашения;
- `POST /api/v1/workspaces/:workspaceId/invitations` и `DELETE .../:invitationId`;
- `PATCH`/`DELETE /api/v1/workspaces/:workspaceId/members/:userId`;
- `GET /api/v1/invitations/:token` и `POST /api/v1/invitations/:token/accept`;
- `GET`/`POST /api/v1/exchange-connections`;
- `PUT /api/v1/exchange-connections/:connectionId/credentials` и `DELETE .../:connectionId`;
- `POST /api/v1/exchange-connections/:connectionId/verify` — проверка ключа и permissions;
- `GET /api/v1/overview`;
- `GET /api/v1/markets` и `GET /api/v1/markets/:symbol`;
- `GET /api/v1/market-catalog` — доступные Bybit linear perpetual инструменты и их
  торговые ограничения; каталог доступен только при активном Bybit connection;
- `POST /api/v1/markets` и `DELETE /api/v1/markets/:symbol` — owner-only управление
  market universe текущего workspace;
- `PUT /api/v1/watchlist/:symbol` и `DELETE /api/v1/watchlist/:symbol`;
- `GET /api/v1/trades` и `GET /api/v1/trades/:tradeId`;
- `GET /api/v1/strategies` и `POST /api/v1/strategies`;
- `GET /api/v1/strategies/:strategyId`;
- `POST /api/v1/strategies/:strategyId/versions`;
- `POST /api/v1/strategies/:strategyId/status`;
- `GET /api/v1/validations`;
- `GET /api/v1/validations/:validationRunId?tradePage=1&tradeLimit=50`;
- `POST /api/v1/strategies/:strategyId/validations`;
- `GET /api/v1/deployments`;
- `POST /api/v1/strategies/:strategyId/deployments`;
- `POST /api/v1/deployments/:deploymentId/commands`;
- `POST /api/v1/positions/:positionId/close`;
- `GET /api/v1/analytics?period=24h|7d|30d|90d|all&environment=&strategyId=&symbol=`;
- `GET /api/v1/experiments?period=24h|7d|30d|all&family=&riskTier=&symbol=`;
- `GET /api/v1/health`.
- `GET /api/v1/activity?period=24h|7d|30d|all&action=&strategyId=&symbol=&reasonCode=&cursor=`.
- `GET /api/v1/journal?period=7d|30d|90d|all&kind=&strategyId=&symbol=&tag=&cursor=`;
- `POST /api/v1/journal/entries` и `POST /api/v1/journal/reviews`.
- `GET /api/v1/playbooks?status=&strategyId=&tag=&query=`;
- `POST /api/v1/playbooks`, `PUT /api/v1/playbooks/:playbookId`;
- `POST /api/v1/playbooks/:playbookId/status`.
- `GET /api/v1/system/logs?period=&level=&service=&correlationId=&query=&cursor=`;
- `GET /api/v1/settings` и `PUT /api/v1/settings/preferences`;
- `GET /api/v1/settings/export`.

Analytics строится на сервере из канонического журнала закрытых сделок. Период, контур,
стратегия и пара фильтруются до расчёта. Проекция содержит net/gross PnL, win rate,
profit factor, expectancy, costs, equity, drawdown, дневной PnL, распределения по
результату/времени в позиции и breakdowns по strategy version, symbol, exit reason,
market regime и UTC-сессии входа. Regime и session фиксируются в Position при входе и
копируются в каноническую Trade при закрытии; старые записи получают `unknown`. Стартовая точка equity берётся из
`DRY_RUN_INITIAL_BALANCE`; это аналитическая база текущего development-контура, а не
исторический account snapshot.

Experiments объединяет каждый deployment и его immutable strategy version в отдельную
строку сравнения. Проекция нормализует общий результат относительно одинакового
`DRY_RUN_INITIAL_BALANCE`, отдельно показывает realized/unrealized PnL, текущую gross/long/short
экспозицию, win rate, profit factor, expectancy, drawdown и издержки. Фильтры периода,
семейства, уровня риска и пары применяются на сервере. Достаточность выборки считается по
неизменяемому журналу закрытых сделок: до 30 — данных мало, 30–99 — предварительно,
100–199 — можно сравнивать, 200+ — достаточная база. Контрольные точки 30/100/200
восстанавливаются детерминированно вместе с метриками на момент их достижения.

Графики Overview и Analytics всегда получают полную доступную историю. Масштаб 24 часа
используется по умолчанию; переключение на 7 или 30 дней меняет только ширину видимого
окна, не фильтрует исходные точки и не вызывает повторную загрузку из-за масштаба. Старую
историю можно просматривать горизонтальным pan; ручной pan/zoom не сбрасывается при
фоновом обновлении, а кнопка «Период» возвращает выбранную ширину окна.

Health projection проверяет API/database, worker heartbeat, Bybit public connection,
свежесть market/account данных, validation queue, runtime failures, rejected orders и outbox lag. Worker с
интервалом `WATCHDOG_INTERVAL_MS` сохраняет edge-triggered инциденты и автоматически
закрывает их после восстановления. Drift сравнивает runtime только с тем validation run,
который зафиксирован в immutable execution context; до 20 закрытых сделок вывод не
делается.

Worker каждые `INSTRUMENT_SYNC_INTERVAL_MS` сверяет отслеживаемые Bybit-инструменты со
статусами `Trading` и `Closed`. Выход пары из `Trading` отключает её ingestion,
ставит использующие её running deployments на паузу, блокирует новые candle/realtime-входы
на транзакционной границе и создаёт критичный health incident. Возврат в `Trading`
восстанавливает сбор данных, но deployment требует осознанного ручного resume.

Перед обработкой каждой runtime-свечи worker проверяет полное непрерывное окно данных до
последней завершённой свечи. При пропуске выполняется REST-backfill точного диапазона и
повторная проверка; сигнал не рассчитывается, пока окно не восстановлено. Если Bybit не
вернул все свечи, runtime cursor получает `RUNTIME_CANDLE_GAP`, а последняя корректная
позиция курсора не сдвигается.

Public REST клиент проверяет код отказа Bybit до разбора успешных данных и сохраняет
endpoint/retCode/retMsg в ошибке. Неполный успешный ответ, другая категория рынка или
свечи другой пары отклоняются. Ошибка любой страницы исторической загрузки отменяет
весь результат; recovery повторяет запрос через существующий backoff, не принимает
частичную историю за завершённую и не выполняет немедленные внутренние retries.

Runtime использует только свечи с `MarketCandle.isClosed=true`: WebSocket выставляет
признак по подтверждению, REST — для свечей, завершившихся к началу запроса. Пакетное
сохранение обновляет также предыдущие свечи; закрытая свеча не заменяется незавершённым
снимком. После миграции прежние записи требуют повторного подтверждения через ingestion
или backfill. Это проверка полноты данных, а не replay всех сделок за время простоя.

Activity — отдельный продуктовый audit trail на основе `Decision`, а не представление
raw logs. Лента поддерживает серверные фильтры и keyset pagination, показывает factors,
correlation/market reference, execution provenance и точные ссылки на position/trade,
если решение создало или закрыло торговый результат.

Journal хранит типизированные гипотезы, наблюдения, выводы и решения. Запись может
ссылаться на strategy/version, execution или validation run, trade, runtime decision и
symbol; цель ссылки проверяется в текущем workspace. Review session фиксирует выбранный
период, итог, выводы и следующие действия, а также неизменяемый состав попавших в период
записей. Создание записей и разборов отражается в audit trail.

Playbook хранит условия рынка, правила входа/выхода/риска, явные условия инвалидации и
чек-лист. Он может ссылаться на стратегии и закрытые сделки текущего workspace, но эти
связи справочные: создание и редактирование плейбука не меняет immutable strategy config
и не запускает runtime. Редактирование защищено `expectedUpdatedAt`, смена статуса —
ожидаемым текущим статусом и audit reason. Удаление заменено обратимой архивацией;
история версий плейбука остаётся задачей после P1.

System Logs хранит отдельный структурированный технический поток. API записывает
мутации и ошибки без request body, headers и cookies; секретоподобные ключи и значения
редактируются при записи и повторно при выдаче. Экран поддерживает фильтры, keyset
pagination, раскрытие metadata/correlation id и вручную включаемый live tail.

Desktop-навигация разделена на рабочую область, исследования и систему. Базовые поля,
select-контролы, focus states и reduced-motion поведение живут в `packages/ui`; мобильная
адаптация на текущем этапе намеренно не полируется.

Settings сохраняет timezone и плотность таблиц с optimistic conflict protection.
Остальные секции показывают реально действующие runtime safety limits, интервалы market
data, состояние public/private exchange connection, notifications и retention без
фиктивных переключателей. JSON-экспорт содержит настройки, стратегии и версии, сделки,
journal/reviews и playbooks, но исключает candles, system logs и secrets; экспорт
фиксируется в audit trail.

Strategy workspace получает рассчитанную сервером lifecycle-модель. Ручной переход
статуса требует ожидаемый текущий статус и комментарий, записывается вместе с audit
event и отклоняется при активной проверке/deployment либо отсутствии успешной проверки
последней версии. Новая версия разрешена только для draft/approved и возвращает
approved-стратегию в draft.

Validation-команда принимает только последнюю версию, timeframe и пары из её config.
Создание `ValidationRun`, durable `Job`, audit event и переход стратегии в validating
выполняются одной транзакцией. Worker забирает задачи через lease, загружает завершённые
свечи Bybit, сохраняет их пакетами и выполняет детерминированный backtest либо
walk-forward. Результат содержит PnL, доходность, drawdown, profit factor, expectancy,
комиссии, сделки, validation gates и SHA-256 provenance фактического датасета. Один run
ограничен 10 парами и 250 000 свечей; при недоступных или недостаточных данных run
завершается явной ошибкой без синтетического результата.

Перед расчётом worker материализует фактические свечи в immutable `DatasetSnapshot`.
Snapshot хранит source, timeframe, пары, фактический диапазон, candle count и content
hash; одинаковый завершённый исторический набор данных повторно используется внутри
workspace без повторной загрузки с биржи. Validation run
ссылается на snapshot до запуска engine, поэтому после потери lease или перезапуска
worker продолжает работу на том же наборе, а не загружает изменившуюся историю заново.

Research integrity дополнительно проверяется versioned golden fixtures из `research/golden`.
`pnpm research:verify` запускает независимый candle-event runtime replay и backtest на
одной последовательности свечей, требует одинаковые сделки/PnL/fees и сверяет решения и
метрики с golden snapshot. Граница проверки явная: realtime quote path потребует отдельного
fixture с точным порядком котировок. Validation, Analytics и Experiments используют единый
provenance-контракт с environment, exchange/source/instrument type, версиями dataset,
config и engine, hashes, freshness и `asOf`.

Funding пока отключён политикой `cryptoanal-funding@disabled-v1`: runtime пишет ноль,
legacy-сделки с ненулевым funding исключаются из Analytics и Experiments. Включать funding
можно только после воспроизводимого теста exchange timestamps, ставок, позиции и cash flow.
Правила обновления fixtures описаны в [`research/README.md`](research/README.md).

Каталог validation возвращает только лёгкие summary-метрики. Полные equity points,
per-symbol breakdown и provenance загружаются отдельным detail-запросом. Все сделки run
хранятся в `ValidationTrade` и выдаются страницами до 100 строк, поэтому размер списка
запусков не растёт вместе с историей сделок. В provenance отчёта также отображаются
идентификатор, hash, источник и фактические границы immutable dataset snapshot.

Dry-run deployment создаётся только для активной approved-версии, имеющей завершённую
passed-валидацию с тем же config hash. Каждая стратегия автоматически получает отдельный
виртуальный account `${DRY_RUN_ACCOUNT_ID}:strategy:<strategyId>`; на один такой account
допускается один deployment в состоянии ready/running/paused. Поэтому несколько стратегий
могут безопасно исполняться параллельно без смешивания капитала, дневного PnL и открытых
позиций. Start создаёт новый immutable
`ExecutionRun.context` с version/config/validation provenance, безопасным snapshot
выбранного `ACTIVE` Bybit connection и SHA-256 context hash;
pause/resume продолжают тот же run, stop завершает его. Каждая команда требует
`expectedStatus`, reason и idempotency key, а результат и audit event записываются в той
же транзакции. Runtime остаётся `dry-run`: привязка не отправляет приватные ордера. Start
и resume повторно проверяют connection. Замена истёкших ключей разрешена при
приостановленных deployment без остановки сопровождения открытых позиций; для активного
connection замена ключей, а также отзыв любого connection блокируются до остановки deployment.

Worker получает отдельные сделки `publicTrade` и подтверждённые закрытия свечей через
public Bybit WebSocket. Каждый полученный trade сохраняется в `MarketPriceEvent` с уникальным
биржевым ID; очередь сохраняет порядок и повторяет запись при ошибке. Единственный writer
выбирается через lease в PostgreSQL. SL, TP, break-even и trailing обрабатывают последовательность
событий пакетами, а не последнюю цену за секунду. Прогресс `Position.priceEventId`, состояние
защиты и версия `runtimeVersion` записываются атомарно. Повторный обработчик не может
ослабить защиту или дважды закрыть позицию. Новые входы требуют свежей сохранённой цены.

После смены или отсутствия подтверждённого потока worker восстанавливает
позицию по журналу, минутным OHLC и истории сигналов. Неполная история блокирует дальнейшую
обработку и входы на аккаунте; окно ограничено `RUNTIME_RECOVERY_MAX_HOURS`. OHLC не доказывает
порядок экстремумов: при неоднозначной активации защиты или пересечении в неполной минуте
позиция закрывается по известной цене восстановления с причиной `recovery-exit`. Такие
сделки являются консервативной симуляцией, а не восстановленными биржевыми исполнениями.
Долгий интервал между trades в том же durable stream не вызывает REST recovery:
свежесть цены проверяется отдельно при входе. Reconnect и переполнение журнала меняют
stream ID и требуют восстановления. На точной минутной границе следующая минута
не запрашивается и не оценивается. Частичный OHLC используется только как граница
возможных цен: не изменяет bestPrice или защиту позиции. Если возможное изменение
касается только bestPrice без изменения SL/trailing, позиция остаётся открытой.
В audit event `position.recover` и factors закрытия сохраняются причина, диапазон, источник и качество recovery,
включая причину неоднозначности; будущие экстремумы не считаются известным исполнением.
Пропущенные свечные сигналы также проверяются; запоздалый выход исполняется по доступной цене,
старые сигналы входа задним числом не исполняются. Открытие и закрытие атомарно создают
канонические `Decision`, `Position`, `Order`, `Fill` и `Trade`.

Перед сетевым recovery worker сохраняет безопасно обработанный участок журнала вместе
с защитой позиции. История сначала читается из закрытых свечей БД; совпадающие запросы
объединяются и кэшируются на 10 секунд, сетевые отказы повторяются с задержкой 2–30 секунд.
REST recovery ограничен `RUNTIME_RECOVERY_TIMEOUT_MS`, сопровождение выполняется максимум
для `RUNTIME_POSITION_CONCURRENCY` позиций одновременно. Ошибка recovery блокирует входы
на связанном аккаунте и снимается только после достижения хвоста журнала или закрытия
позиции; обычный свечной цикл её не сбрасывает.
Свечной цикл при CAS conflict перечитывает состояние и заново строит решение, максимум
три попытки на пару. Исчерпание попыток или ошибка одной пары не пропускает остальные
пары стратегии; конфликты отмечаются в debug logs.

Открытые позиции имеют один обработчик цен и сигнальных выходов: при каждой котировке
сначала проверяются SL/TP/trailing, затем подтверждённые свечные сигналы и только затем
обновляется защита. При одинаковом времени price touch имеет приоритет. Свечной цикл
занимается новыми входами и не закрывает открытые позиции. `Position.signalCandleAt`
сохраняется атомарно с ценовым прогрессом и защитой; рестарт продолжает ту же последовательность.
`MarketCandle.finalizedAt` фиксирует первое сохранение закрытой свечи и не переносится
при повторном backfill. Доступность сигнала учитывает также поздние свечи прогрева.
Сигнал использует первую котировку, полученную журналом после доступности всех его данных;
вход на котировке до finality отклоняется обоими путями записи. Pending signals сохраняют
`availableAt`; старые realtime pending без этого поля не исполняются и отклоняются с причиной.
Возраст и время данных, finality, исполнения и решения сохраняются отдельно в factors.
Проигрывание старого журнала явно помечается `journal-replay`, восстановление OHLC —
`ohlc-recovery`; их времена симуляции не являются биржевыми fills.

Отложенные входы обрабатывают publicTrade журнал по `RuntimeCursor.pendingPriceEventId`:
краткое касание лимита и последующий отскок сохраняют возможность исполнения.
Пакет ограничен 2000 событиями; курсор записывается под CAS по сигнальной свече и предыдущему
событию, повторный пакет или другой worker не создаёт второй вход. Новая сигнальная свеча
сбрасывает этот cursor. Retention журнала учитывает активные pending cursors.
Вход допускает только свежие события текущего stream после detectedAt/availableAt, до
expiresAt; устаревшие события и прежний stream пропускаются без исторического исполнения.
Срок повторно проверяется по clock_timestamp внутри транзакции после lock и перед записью.
Finality и направление сверяются с сохранённым pending, не только с входными аргументами.
Expiry и terminal risk/capacity rejection очищают pending с одной SKIP decision и причиной;
простое отсутствие касания продвигает cursor и оставляет ожидание. Ожидание цены — HOLD,
OPEN — исполненный вход. Новый сигнал получает стабильный ID из запуска/пары/сигнальной
свечи: SIGNAL сохраняется в audit event, PENDING/FILLED/EXPIRED/REJECTED — в
`Decision.factors.runtimeSignal` с тем же ID и причиной; pending JSON хранит `signalId`.
Observation и decision записываются одной транзакцией, retry не дублирует SIGNAL.
Для legacy pending ID выводится при обработке; отсутствующая старая история не создаётся.
Pending сохраняет отдельные HOLD/PENDING решения при смене причины ожидания:
недоступное подключение/инструмент, отключённый поток, неисправный журнал, отсутствие,
устаревшее время или прежний stream котировки, цена до подтверждения сигнала и отсутствие
касания лимита. Повтор той же причины подряд, в том числе после рестарта, не создаёт
новую decision; прогресс прочитанных событий сохраняется независимо. При закрытом
подключении/инструменте события не потребляются и исполнение запрещено, но expiry
обрабатывается и сохраняет последнюю причину ожидания. При PAUSED отдельный pending
цикл не исполняет сигнал; истекший сигнал после resume не исполняется.
Новая свеча завершает прежний realtime pending одной terminal decision до замены cursor:
EXPIRED при истечении срока или REJECTED с `ENTRY_SIGNAL_SUPERSEDED` при досрочной замене.
Сохраняются прежний signal ID, причина ожидания и ссылка на новую свечу. Это работает
также при новой свече без сигнала или на паузе. Завершение старого сигнала, решение
новой свечи и cursor записываются атомарно; ошибка откатывает все изменения.
Рыночный сигнал действует не более `RUNTIME_MARKET_ENTRY_TTL_MS` от закрытия сигнальной
свечи (по умолчанию 60 секунд), независимо от timeframe и времени получения данных после
простоя. Абсолютное отклонение котировки от signal price ограничено
`RUNTIME_MARKET_ENTRY_MAX_DEVIATION_BPS` (50 bps = 0.5%) в обе стороны; это отклонение
исходной котировки до моделируемого slippage. Проверки повторяются под транзакционными
блокировками по DB clock и durable event. Expiry/deviation сохраняются как
`ENTRY_SIGNAL_EXPIRED`/`ENTRY_PRICE_DEVIATION` с состоянием EXPIRED/REJECTED и единым ID;
market entry policy записывается в factors. Более ранний сохранённый expiry не продлевается.
Лимитные сигналы сохраняют свой свечной TTL и не получают market deviation gate.
Исторические validation не пересчитываются: свечной backtest не моделирует этот
контроль задержки/котировки runtime. Требуется миграция `20261004190000_pending_entry_event_cursor`.

Индикаторы используют общий расчёт `cryptoanal-indicators@2.0.0`: EMA инициализируется
через SMA, RSI — через Wilder. `RuntimeCursor.indicatorState` хранит рекурсивные значения,
ограниченный хвост свечей и время доступности исходных данных. Состояние записывается
одной транзакцией с решением и cursor; устаревший worker не может его заменить.
После рестарта пропущенные свечи проигрываются по порядку, без переинициализации EMA/RSI.
При входе `Position.indicatorState` получает отдельную копию checkpoint сигнала.
Сигнальное сопровождение продолжает её только до реально обработанной доступной свечи;
состояние, signal cursor и price progress сохраняются атомарно под `runtimeVersion`.
Свечной cursor запуска может идти дальше и не пропускает ещё не обработанные выходы позиции.
Recovery использует это же состояние; после рестарта история читается от ограниченного хвоста,
а не заново от входа. Состояние сохраняется также при закрытии для воспроизводимости.
Replay ограничен 50 000 свечами; неполная история, повреждённое/несовместимое состояние
или изменение проверяемого хвоста блокируют продолжение. Более ранние изменения
истории требуют отдельного replay и ещё не обнаруживаются автоматически.

При первом запуске без checkpoint worker использует полный immutable dataset из validation,
на основании которой стартовала стратегия. Новые execution contexts закрепляют ID/hash snapshot;
старые ссылки `dataset-snapshot:` также читаются. Начальное состояние EMA/RSI совпадает с
расчётом от начала этого snapshot, после чего новые свечи продолжают тот же рекурсивный хвост.
Checkpoint и factors сохраняют `indicatorAnchor` с ID/hash, диапазоном и исходной версией validation.
Отсутствующий или изменённый snapshot, будущие свечи, недостающий символ и неполный прогрев
дают явную ошибку; ссылка не заменяется другим датасетом. Компактные seed состояния кешируются
с ограничением 64 набора; сырые snapshot не сохраняются в кэше.
Run без immutable snapshot использует минимальную историю с отметкой `legacy-window`;
уже сохранённый legacy checkpoint автоматически не меняется. Уже открытые позиции без
checkpoint сохраняют прежнюю точку начала перед входом до закрытия. Старое рекурсивное
состояние восстановить из прежних решений нельзя.
Walk-forward 0.9.0 использует один расчёт индикаторов от начала полного snapshot во всех
окнах, без нового SMA seed при сдвиге training window. Source validation старой версии
указывает происхождение данных; её исторические результаты не пересчитываются под новую
семантику. Для сравнения эффективности стратегий нужны новые validation runs.
Новые сигналы всех семейств требуют полного непрерывного 24h объёма, даже при нулевом
пороге фильтра. До прогрева `volume24h` равен `null`; после пропуска свечи пакетный расчёт
начинает прогрев заново, а runtime сначала требует восстановления непрерывной истории.
Символы рассчитываются независимо, дубли времени отклоняются. Z-score использует
двухпроходную дисперсию текущего окна; объём суммируется по текущему окну, что исключает
зависимость rolling признаков от размера пакета. Validation 0.9.0 и candle replay 1.3.0 используют общий код индикаторов.
Для новых validation worker загружает непрерывный прогрев перед выбранной датой начала;
он входит в immutable snapshot и его hash, но не в сделки, equity samples и число свечей оценки.
Backtest исполняет сделки в выбранном периоде; walk-forward учитывает только полные тестовые
окна и сохраняет training отдельно. Суточные точки капитала отсчитываются от начала оценки.
`metrics.evaluation` содержит фактические границы, полный размер snapshot, прогрев/training
и исключённый остаток; `provenance.candleCount` остаётся полным размером исходных данных.
При вызове движка без явного периода первые `minimumExecutionCandleCount` интервалов backtest
отведены прогреву. Annual backtest также требует историю перед началом выбранного года.
Старые метрики остаются читаемыми без `evaluation`; старые snapshot без нужного прогрева
не дополняются автоматически при повторной обработке. Для них нужно создать новую проверку.
Старые результаты и сделки не пересчитываются.
Для checkpoint требуются миграции `20261004160000_indicator_checkpoint` и
`20261004180000_position_indicator_checkpoint` перед обновлением worker.
Изменения требуют миграции `20261004120000_runtime_signal_order` перед обновлением worker.
Старым закрытым свечам без finality время доступности назначается при первом использовании;
время их исторического получения не выдумывается. Старые сделки миграция не пересчитывает.

Раздел «Здоровье системы» показывает очереди цен по открытым позициям. Watchdog отдельно
выявляет устаревший источник, смену потока без восстановления и события, полученные
более `RUNTIME_QUOTE_MAX_AGE_MS` назад и ещё не обработанные. Тихий рынок без очереди
не считается отставанием обработчика. Число событий ограничено выборкой: `> 2000`
означает, что очередь больше показанного значения. Новые incidents доступны в dashboard;
внешняя доставка уведомлений остаётся отдельной задачей.

Каждый новый свечной runtime decision теперь связан с immutable `DecisionContextSnapshot`:
закрытые OHLCV основного и старших таймфреймов, ADX/CHOP/ATR/RVOL/MACD/Z-score/slopes,
позиция, капитал, экспозиция, risk limits и bounded memory последних решений. Snapshot
имеет versioned feature set и SHA-256 content hash. `Decision` отдельно хранит provider,
candidate и итоговый verdict движка. Provider-neutral shadow runner может отдать один
snapshot нескольким кандидатам; сохранённые ответы оцениваются deterministic replay без
повторного обращения к модели. Внешний LLM provider и его credentials пока не подключены.

Независимый risk guard учитывает реализованный и плавающий PnL, комиссии и ожидаемую стоимость
выхода. Дневной лимит считается по UTC: прибыль открытых позиций не компенсирует убыток других,
а переносимые позиции включаются с полным текущим плавающим убытком. Срабатывание сохраняется
до следующих суток, блокирует входы и закрывает позиции по свежим ценам. Используется наиболее
строгий дневной лимит сервера и стратегий открытых позиций. Лимиты количества позиций,
экспозиции и риска до стопа с издержками проверяются повторно в транзакции под общим lock
workspace, включая одновременные входы разных deployments одного виртуального аккаунта.
Для общего аккаунта также запрещены одновременные противоположные позиции по одной паре.

Отдельный календарный лимит новых входов использует `schedule.timezone` текущей стратегии:
сумму netPnL закрытых DRY_RUN сделок всего виртуального аккаунта от местной полуночи
до времени проверки и `initialBalance × maxDailyLossPercent`. Порог включительный;
причина отказа — `STRATEGY_DAILY_LOSS_LIMIT`. Обычный и pending вход проверяют его
одинаково, включая повторную проверку под общим lock в транзакции. Время и начало
суток берутся из БД; переход DST учитывается. Этот лимит не закрывает позиции и не
создаёт latch; UTC safety limit с плавающим убытком и издержками действует независимо.
Новые входы также ограничены общим бюджетом риска до стопов. Открытые позиции
резервируют дополнительный возможный убыток сверх уже учтённых текущих потерь и
издержек; используется ближайшая действующая защита (stop/trailing). Остаток равен
меньшему из свободного UTC дневного бюджета и капитала без плавающей прибыли, минус
этот резерв. Worker уменьшает новую позицию под остаток, БД повторяет проверку под lock;
конкурентный вход может получить `MAX_ACCOUNT_STOP_RISK`. Резервирование не включает
pending, пока вход не исполнен, и само по себе не запускает принудительное закрытие.
Рыночный гэп всё ещё может дать убыток больше расчётного риска до стопа.

В Settings владелец workspace может включить постоянную аварийную остановку: новые входы
блокируются сразу после сохранения, а независимый цикл закрывает dry-run позиции по свежим
ценам. Без свежей цены закрытие ждёт восстановления потока. API
`PUT /api/v1/settings/runtime-safety` принимает `{ enabled, reason, expectedVersion }`, требует
owner и CSRF, пишет audit event и возвращает 409 при устаревшей версии. Отключение остановки
не снимает дневную блокировку. Это управление симуляцией; Bybit Demo/Live orders не добавлены.

Pause запрещает новые входы, но продолжает сопровождать уже открытые позиции. Stop
недоступен до их закрытия. Ручное закрытие выполняется на странице `/trades` по свежему
market snapshot и имеет собственные idempotency receipt и audit event. Runtime и
validation используют общие функции сигналов, risk sizing, комиссий, slippage и exit
rules; источник цены исполнения различается явно: историческая свеча в validation и
realtime quote в runtime.

Validation 0.9.0 и candle replay 1.3.0 ограничивают размер позиции тем же расчётом,
что и realtime: риск до стопа включает входную комиссию, проскальзывание стопа и
комиссию выхода; доступная экспозиция включает входную комиссию. Повторное ограничение
по актуальному equity не увеличивает уже рассчитанную позицию. Старые результаты
validation сохраняют прежнюю версию и требуют повторной проверки для сравнения.
Единый расчёт размера пока не означает одинаковый учёт портфеля: дневной UTC safety
limit и плавающий риск аккаунта в runtime ещё отличаются от исторической validation.

Оба пути новых входов повторно проверяют состояние deployment и активность connection;
отказ подключения не отключает сопровождение открытых позиций. Equity для sizing и
account snapshots учитывает комиссии уже открытых позиций, а сделки и позиции читаются
в согласованном снимке БД. REST-запросы Bybit ограничены 15 секундами. Worker получает
уникальный идентификатор при каждом старте, в том числе внутри контейнера.

В Health для открытых позиций отдельно показаны возраст последней цены, задержка её
получения (`receivedAt − observedAt`), отставание позиции от последнего события журнала
и возраст самого старого ожидающего события. Все значения рассчитаны на `checkedAt`
ответа API; они также входят в metadata incidents. Пустая очередь даёт нулевое
отставание даже на тихом рынке; отсутствующий timestamp показывается как неизвестный.
Разница времён цен не является измерением длительности обработки или её p95.

Результаты проверки и оставшиеся ограничения: [аудит движка](docs/runtime-audit-2026-09-19.md).

Exit-конфигурация поддерживает базовые SL/TP, trailing-stop, порог его активации в `R`,
а также перенос stop в cost-adjusted безубыток после заданного благоприятного движения.
Для EMA crossover можно включить закрытие по обратному пересечению на завершённой свече.
Нулевой порог безубытка отключает перенос, а нулевой порог trailing сохраняет прежнюю
немедленную активацию. Лучшая достигнутая цена позиции сохраняется независимо от trailing.

Конфигурация явно выбирает `ema-crossover`, `breakout`, `mean-reversion` или `momentum`.
Для каждого семейства редактор показывает только относящиеся к нему параметры, а runtime
и validation рассчитывают один и тот же сигнал. Текущий development-портфель содержит 15
изолированных dry-run accounts; приватные биржевые ордера по-прежнему не отправляются.

Проверенные EMA-кандидаты на 5m не прошли минимальный backtest gate по profit factor и
expectancy, поэтому в runtime не запущены и до walk-forward не допущены. Результаты
сохранены в `docs/rebuild/15-PARALLEL-STRATEGY-EXPERIMENTS.md`.

Текущая execution policy использует 1× совокупную экспозицию: номинал одной позиции
ограничен `equity / maxOpenPositions`. Явные leverage и max exposure появятся вместе с
общим runtime execution context; до этого validation не предполагает скрытого плеча.

## Проверки

```bash
pnpm runtime:verify
pnpm runtime:ledger
pnpm research:verify
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm check:budgets
```

`runtime:verify` проверяет TypeScript тестов и выполняет сценарии исполнения. Для
интеграционных проверок нужна отдельная PostgreSQL-база с именем
`cryptoanal_runtime_test_*` и переменная `RUNTIME_TEST_DATABASE_URL`. Тесты создают в ней
синтетические записи; без переменной блок PostgreSQL явно пропускается.

`runtime:ledger` читает согласованный read-only снимок рабочей БД: сверяет все
сделки, позиции, fills, комиссии и решения; показывает задержки сопровождения,
cursor failures и открытые incidents. Команда не изменяет записи. Необязательный
путь сохраняет JSON: `pnpm runtime:ledger /tmp/cryptoanal-ledger.json`. Исторические
цены с округлением до восьми знаков проверяются с соответствующим допуском;
результат не подтверждает каждое касание цены до границы хранения price journal.
Итог независимой проверки: [14 октября 2026](docs/engine-verification-2026-10-14.md).

```bash
DATABASE_URL="$RUNTIME_TEST_DATABASE_URL" pnpm exec prisma migrate deploy
pnpm runtime:verify
```

При обновлении существующего окружения сначала примените миграции
`20260919130000_runtime_candle_finality`, `20260919130100_runtime_position_revision` и
`20260925120000_add_decision_context_engine`
через `pnpm exec prisma migrate deploy`, затем пересоберите и перезапустите приложения.
Проверка кода сама по себе не обновляет уже работающие Docker-контейнеры.

`check:budgets` запускается после сборки и ограничивает gzip-размер entry JS, всего JS,
CSS, отдельного route chunk и изолированных `lightweight-charts` и Radix UI vendor chunks.
Интервальный refetch привязан к активным страницам; системные логи обновляются
автоматически только после явного включения.

Read-only аудит legacy PostgreSQL и локальный архив:

```bash
pnpm migration:audit -- --source-env ../crypto-trade/bot/.env
```

Команда не подключается к новой БД. Она сохраняет manifest и gzip-архив business data в
игнорируемом `var/legacy-migration`; подробный mapping описан в
[`docs/rebuild/12-LEGACY-DATA-MIGRATION.md`](docs/rebuild/12-LEGACY-DATA-MIGRATION.md).

Локальный backup и изолированная проверка восстановления:

```bash
pnpm db:backup
pnpm db:restore-check
```

Артефакты сохраняются с правами `0600` в игнорируемом `var/backups`. Restore-check
использует отдельные временные Docker container/volume и не изменяет рабочую базу.
После успешного restore-check автоматически сохраняются три последние проверенные
копии каждой базы; более старые dump, manifest и отчёты удаляются. Новые непроверенные
копии остаются до завершения проверки. Перед очисткой повторно проверяются SHA-256
и размер сохраняемых dump; если проверенных копий меньше трёх, удаления нет.

Предварительный просмотр и ручная очистка существующих копий:

```bash
pnpm db:backup:prune -- --dry-run
pnpm db:backup:prune
```

Очистка касается только распознанных наборов PostgreSQL backup; `.env` и другие
файлы в `var/backups` не удаляются. Тесты хранения: `pnpm db:backup:test`.

## Безопасность development-этапа

Dashboard содержит private account/runtime данные и управляющие действия. Private API
требует server-side session; сырой token хранится только в `HttpOnly` cookie, а в БД — его
hash. Изменяющие запросы защищены CSRF, login ограничен по частоте, workspace выбирается
только через membership. Для production необходимо задать случайный `AUTH_SECRET` длиной
не менее 32 символов, отдельный `EXCHANGE_CREDENTIALS_KEY` и использовать HTTPS.

Публичный signup и автоматическая email-доставка пока отсутствуют. Владелец создаёт
одноразовую invite-ссылку в `/settings`; в БД хранится только SHA-256 токена. Новый
пользователь задаёт имя и пароль, существующий подтверждает свой пароль. Пароли сохраняются
как Argon2id hash. Для bootstrap остаётся `pnpm auth:create-user`; пароль передаётся только
через `CRYPTOANAL_NEW_USER_PASSWORD`.

До подключения email-провайдера администратор выпускает recovery-ссылку вручную:

```bash
pnpm auth:create-recovery --email owner@example.com
```

Ссылка одноразовая и действует `AUTH_RECOVERY_TTL_MINUTES`. Восстановление отзывает все
активные сессии пользователя. Обычный вход ограничен `AUTH_MAX_ACTIVE_SESSIONS`; лишние
старые сессии закрываются автоматически.

Приватные Bybit credentials шифруются AES-256-GCM отдельным ключом окружения. API никогда
не возвращает исходные значения, а после отзыва подключения ciphertext удаляется. До
ручной проверки через Bybit подключение имеет статус `не проверено`. Проверка использует
подписанный `GET /v5/user/query-api`, сохраняет только безопасную сводку permissions и
отклоняет ключи с разрешением `Withdraw`. Даже статус `ACTIVE` не включает торговлю.
Новый production-ключ можно создать командой
`openssl rand -base64 32` и сохранить как `EXCHANGE_CREDENTIALS_KEY` вне Git.

Private Bybit verification использует `BYBIT_DEMO_BASE_URL` для demo,
`BYBIT_LIVE_BASE_URL` для live и timeout `BYBIT_PRIVATE_REQUEST_TIMEOUT_MS`. Региональный
mainnet-домен при необходимости задаётся через server environment, без изменений frontend.
Если сеть блокирует TLS к REST-доменам Bybit, `BYBIT_PROXY_URL` направляет только REST
запросы public/private клиентов через HTTP CONNECT proxy. Для локального Docker и Happ
используется `http://host.docker.internal:10820`; public WebSocket остаётся прямым.
`BYBIT_PROXY_URL` нужен только при недоступности прямого REST: если Bybit отвечает из
worker напрямую, оставьте переменную незаданной. Указанный локальный прокси должен
быть запущен и доступен именно из Docker; отключённый прокси блокирует REST/backfill
даже при рабочем WebSocket. После изменения `.env` пересоздайте API и worker:
`docker compose up -d --no-deps api worker`. При сетевой ошибке статус показывает
код причины; для недоступного прокси — безопасный адрес без логина и пароля.

После успешной ручной проверки worker перепроверяет connection каждые
`EXCHANGE_VERIFICATION_INTERVAL_HOURS` часов. Claim защищён lease; временная ошибка
переносит попытку на `EXCHANGE_VERIFICATION_RETRY_MINUTES`, но не сбрасывает статус
`ACTIVE`. Окончательная ошибка переводит connection в `INVALID` и создаёт watchdog
incident. `credentialRevision` не позволяет запоздавшему результату проверки перезаписать
уже заменённые ключи.

## Dry-run account

Worker сохраняет account snapshots каждого виртуального strategy account и сводный
`${DRY_RUN_ACCOUNT_ID}:portfolio`. Капитал отдельной стратегии рассчитывается как
`DRY_RUN_INITIAL_BALANCE + realized PnL + unrealized PnL`; portfolio складывает капиталы и
PnL всех известных dry-run accounts. Доступный баланс остаётся неопределённым до появления
risk/margin model или private exchange adapter.

Настройки:

- `DRY_RUN_ACCOUNT_ID` — базовый идентификатор для strategy accounts и portfolio внутри
  каждого workspace;
- `DRY_RUN_INITIAL_BALANCE` — стартовый капитал;
- `ACCOUNT_SNAPSHOT_INTERVAL_MS` — интервал snapshot, по умолчанию 5 минут;
- `INSTRUMENT_SYNC_INTERVAL_MS` — сверка торговых статусов инструментов, по умолчанию 5 минут;
- `RUNTIME_POLL_INTERVAL_MS` — частота поиска новых завершённых свечей, по умолчанию 5 секунд.
- `WATCHDOG_INTERVAL_MS` — частота пересчёта и синхронизации инцидентов, по умолчанию 30 секунд.

Дополнительные параметры P1 dry-run:

- `RUNTIME_QUOTE_INTERVAL_MS` — цикл сопровождения и отдельный risk guard, 1000 мс.
- `RUNTIME_QUOTE_MAX_AGE_MS` — максимальная давность цены для входа и порог backlog incident, 10000 мс.
- `RUNTIME_MARKET_ENTRY_TTL_MS` — срок рыночного сигнала от закрытия свечи, 60000 мс (1000–300000).
- `RUNTIME_MARKET_ENTRY_MAX_DEVIATION_BPS` — абсолютное отклонение котировки от signal price, 50 bps (0–10000).
- `RUNTIME_MAX_DAILY_LOSS_PERCENT` — серверный потолок дневного убытка, 10% начального капитала.
- `RUNTIME_MAX_ACCOUNT_EXPOSURE_PERCENT` — лимит новых входов относительно equity аккаунта, 100%.
- `RUNTIME_MAX_OPEN_POSITIONS` — потолок позиций виртуального аккаунта, 20; стратегия может ограничить сильнее.
- `RUNTIME_RECOVERY_MAX_HOURS` — предел автоматического восстановления, 168 часов; превышение требует разбора позиции.
- `RUNTIME_RECOVERY_TIMEOUT_MS` — срок REST recovery одной позиции, 5000 мс.
- `RUNTIME_POSITION_CONCURRENCY` — число одновременно сопровождаемых позиций, 4.
- `RUNTIME_EVENT_RETENTION_HOURS` — хранение событий, 24 часа; ещё не обработанные открытыми позициями события удерживаются дольше.

Журнал сбрасывается пакетами до 2000 событий каждые 50 мс; переполнение очереди 20000 событий
закрывает входной gate и помечает новый stream для восстановления. `RUNTIME_MARK_PERSIST_INTERVAL_MS`
сохранён для совместимости конфигурации, но сопровождение по журналу больше не использует
старый throttling. Для включения P1 требуется миграция `20260919140000_runtime_event_journal_risk`
и обновление API, worker и dashboard. Старый worker нужно остановить до запуска нового, чтобы
он не писал позиции в обход нового risk gate. Архивные сделки не пересчитываются.
