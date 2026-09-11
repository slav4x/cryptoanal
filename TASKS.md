# Задачи CryptoAnal

## Этап 1 — Foundation

- [x] Создать структуру pnpm monorepo.
- [x] Добавить единые TypeScript, ESLint и Prettier настройки.
- [x] Подготовить локальный PostgreSQL и чистую Prisma-схему.
- [x] Добавить fixed development workspace и `RequestContext`.
- [x] Создать shared API contracts.
- [x] Создать Fastify API с health, context, overview и markets.
- [x] Создать worker foundation с heartbeat.
- [x] Создать shadcn-compatible UI package и semantic tokens.
- [x] Перенести визуальное направление из `crypto-trade/design` в tokens и dashboard shell.
- [x] Сверить desktop-примитивы и ключевые страницы с HTML-мокапами `crypto-trade/design`.
- [x] Собрать dashboard shell, Overview и Markets.
- [x] Подключить реальный public Bybit market data adapter.
- [x] Закрыть dashboard полноценным session-based access gate.
- [x] Упаковать API, worker и dashboard в Docker Compose с healthcheck и автоперезапуском.

## Этап 2 — Trading data

- [x] Market snapshots и 15m candle history ingestion.
- [x] Watchlist mutations.
- [x] Страница пары со свечами, EMA, RSI, ATR и regime.
- [x] Read-model позиций и завершённых сделок.
- [x] Страница открытых позиций и истории сделок.
- [x] Торговый контекст на Overview и странице пары.
- [x] Orders, fills и детальная страница сделки.
- [x] Полный overview projection с account snapshots.

## Этап 3 — Strategies и runtime

- [x] Strategy catalog и status model.
- [x] Секционный strategy editor.
- [x] Создание стратегии с immutable версией v1.
- [x] Strategy workspace с обзором и snapshot конфигурации.
- [x] Последующие immutable versions и diff.
- [x] Lifecycle transitions и validation eligibility.
- [x] Dry-run deployments и execution runs.
- [x] Immutable execution context с hash и provenance validation run.
- [x] Start/pause/resume/stop commands, confirmations, idempotency и audit trail.
- [x] Один активный deployment на изолированный dry-run account.
- [x] Параллельные strategy deployments с автоматическими account ids и portfolio snapshot.
- [x] Добавить в execution/validation engine самостоятельные семейства сигналов для
      широкого сравнительного среза: breakout, mean-reversion и momentum.
- [x] Worker execution loop для активного dry-run deployment.
- [x] Manual close позиции как отдельная команда.
- [x] Перевести public market data на один Bybit WebSocket с динамическими ticker/kline
      subscriptions и REST fallback для восстановления истории.
- [x] Разделить runtime на bar-close signal loop и быстрый quote loop: realtime mark price,
      точные SL/TP/trailing-stop и вход сразу после подтверждённого закрытия сигнальной свечи.
- [x] Проверить отдельные 5m-кандидаты на backtest и walk-forward; не запускать варианты,
      которые не проходят существующие gates.

## Этап 4 — Validation Center

- [x] Единая execution semantics runtime/backtest.
- [x] Immutable dataset snapshots с content hash и повторным использованием исторических
      наборов без повторной загрузки.
- [x] Durable очередь ValidationRun/Job для backtest и walk-forward.
- [x] Run composer и мониторинг очереди в Validation Center.
- [x] Worker execution для backtest/walk-forward jobs.
- [x] Validation gates и provenance.
- [x] Run details и compare.

## Этап 5 — Analytics

- [x] Performance projections и breakdowns.
- [x] Equity, drawdown и PnL calendar.
- [x] Распределения результата и времени в позиции.
- [x] Trade provenance и breakdowns по market regime и UTC-session.
- [x] Health, drift и watchdog.
- [x] Activity/explainability.

## Этап 6 — Разбор и polish

- [x] Journal и review sessions.
- [x] Playbooks.
- [x] System logs и settings.
- [x] Desktop accessibility, keyboard и performance review.
- [x] Пересобрать блок открытых позиций на странице валютной пары в широкую таблицу по
      паттерну страницы «Сделки»: одна позиция — одна строка, без повторяющихся пар
      label/value и визуальной каши при нескольких стратегиях.
- [x] Заменить статичный свечной SVG-график пары подходящей интерактивной библиотекой:
      полная ширина блока, увеличенная высота, pan/zoom, crosshair, управление видимым
      диапазоном и корректный resize.
- [x] Наложить на график пары торговые события всех относящихся к ней сделок: входы,
      выходы, открытые позиции, stop-loss, take-profit и направление; добавить подсказки
      и раздельное включение слоёв позиций и завершённых сделок.
- [ ] Добавить фильтр стратегий для графика пары, когда количество одновременных отметок
      станет мешать чтению данных.
- [x] Пересобрать график капитала на главной через интерактивную библиотеку: полная ширина,
      увеличенная высота, оси, crosshair/tooltip и корректное отображение периодов 24 часа,
      7 дней и 30 дней.
- [x] Исправить scroll policy: при переходе на другой route сбрасывать страницу наверх,
      а при переключении локальных периодов и фильтров внутри страницы сохранять текущую
      позицию прокрутки.
- [x] Провести desktop UI-аудит всех страниц: унифицировать типографику, размеры и высоты
      полей, отступы, состояния focus/error/disabled и заменить нативные `select` единым
      кастомным shadcn-compatible Select. Зафиксировать шкалу контролов 13/12 px и
      однострочное обрезание длинного выбранного значения без смещения стрелки.
- [x] Перевести SVG-графики кривой капитала и просадки на странице «Аналитика» на
      lightweight-charts: crosshair, pan/zoom, значения выбранной точки и reset диапазона.
- [ ] Унифицировать period/viewport для графика капитала на Overview и графиков капитала
      и просадки в «Аналитике»: default `24h`; переключатели `24h / 7d / 30d` загружают
      полный набор точек выбранного периода и устанавливают начальный видимый диапазон
      ровно на него; ручные pan/zoom сохраняются до следующей смены периода. Отдельно
      проверить источник, агрегацию и пропуски, чтобы графики не теряли доступные данные.
- [ ] Mobile responsive review — отложен по решению владельца.

## Этап 7 — Migration

- [x] Inventory и mapping старой БД.
- [x] Read-only gzip-архив legacy business data с manifest и SHA-256.
- [x] Зафиксировать archive-only policy: eligible для автоимпорта 0 записей.
- [x] Сохранить чистый development workspace без legacy-сущностей.
- [x] Backup/restore check в изолированном PostgreSQL.

## Этап 8 — Users и workspaces

- [x] Auth ADR.
- [x] Users, sessions и memberships.
- [x] Session-based `RequestContext`.
- [x] Membership-based workspace isolation для private API.
- [x] Login/logout и workspace switcher в dashboard.
- [x] Создание нового workspace с owner membership и изолированными настройками.
- [x] Invite-only onboarding и управление участниками.
- [x] Управление sessions, смена пароля и одноразовый recovery flow.
- [ ] Public signup, email verification и автоматическая отправка recovery-ссылок.
- [x] Multi-workspace scheduling для runtime/account/watchdog worker.
- [x] Workspace-scoped exchange connections и encrypted credentials.
- [x] Проверка credentials через Bybit, permission policy и lifecycle статусов.
- [x] Привязка deployment к проверенному exchange connection и fail-closed runtime gate.
- [x] Периодическая перепроверка exchange connection с lease, retry и health incidents.
- [x] Миграция development workspace к владельцу.

## Этап 9 — Landing

- [ ] Marketing app.
- [ ] Product, methodology и docs.
- [ ] Public track-record projection.
- [ ] Signup/waitlist и pricing после отдельных решений.

## Идеи

- Shared-account multi-strategy allocation для будущего demo/live execution.
- Team roles beyond owner/member.
- Billing.
- AI assistant.
- Marketplace.
- Multi-exchange.
- Управляемое самообучение стратегий по плану `docs/rebuild/11-SELF-LEARNING-MODELS.md`.
