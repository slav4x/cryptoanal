# Задачи CryptoAnal

## Текущий приоритет и порядок выполнения

Состояние экспериментов на 19 сентября 2026 года: 16 параллельных dry-run deployments,
69 закрытых сделок суммарно, от 0 до 11 сделок на отдельную стратегию. Этой выборки
недостаточно для выбора победителя: первая контрольная точка — 30 сделок на стратегию,
рабочее сравнение — от 100 сделок на каждого отобранного кандидата. Совокупный PnL
изолированных virtual accounts не считать результатом единого портфеля.

Оптимальная последовательность оставшейся разработки:

1. **Strategy chart filtering:** фильтр стратегий на графике пары; выбор universe в
   редакторе и структура настроек уже приведены к workspace-модели.
2. **Market data integrity:** обработка delisting/status, поиск разрывов свечей и
   REST-backfill перед возобновлением торговых сигналов.
3. **Research integrity:** golden datasets, equivalence runtime/backtest, единый
   provenance метрик и окончательное решение по funding.
4. **Первый экспериментальный gate:** не менять конфигурации без ошибки корректности,
   накопить минимум 30 закрытых сделок на стратегию и отобрать 3–5 кандидатов.
5. **Production foundation:** постоянный сервер, CI, резервные копии, наблюдаемость и
   доставка критичных уведомлений. Длительный demo/runtime не должен зависеть от ноутбука.
6. **Portfolio risk:** распределение капитала, конфликтная политика, совокупные лимиты,
   daily loss limit и глобальный kill switch.
7. **Bybit Demo execution:** реальные demo orders/fills, reconciliation и восстановление
   после перезапуска. Live execution до отдельного operational review запрещён.
8. **Второй экспериментальный gate:** сопоставить dry-run fill model с demo fills и
   накопить минимум 100 сделок на каждого отобранного кандидата.
9. **Client hardening:** onboarding, empty states, quotas, lifecycle пользовательских
   данных, production key management и удаление development-доступа.
10. **Landing:** позиционирование, публичный track record, waitlist/signup и pricing —
    только после подтверждения предыдущих stop-gates.

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
- [x] Заменить фиксированный список из восьми пар на workspace-scoped market universe:
      пользователь управляет списком отслеживаемых инструментов в разделе «Рынок», а
      worker динамически включает и отключает их ticker/kline ingestion и WebSocket
      subscriptions без изменения конфигурации приложения.
- [x] Добавить API каталога доступных инструментов по активным проверенным подключениям
      бирж. На первом этапе поддержать Bybit; не смешивать одинаковые символы разных бирж
      и сохранять provenance `exchange + market type + symbol`.
- [x] Добавить на страницу «Рынок» действие «Добавить пары» с modal/drawer: поиск,
      фильтрация, множественный выбор доступных Bybit-инструментов, отметка уже добавленных
      и атомарное добавление выбранных пар в market universe. Каталог показывать только для
      бирж с `ACTIVE` connection; отсутствие подключения объяснять внутри интерфейса.
- [x] Расширить модель инструмента и API обязательными exchange constraints: `exchange`,
      `marketType`, `baseAsset`, `quoteAsset`, `tickSize`, `qtyStep`, `minOrderQty`,
      `minNotional`, торговый статус и время последней синхронизации.
- [ ] До подключения второй биржи перевести первичный ключ инструмента и все внешние связи
      с `symbol` на `exchange + marketType + symbol`. Текущий Bybit-only этап защищён от
      смешивания конфликтом, но ещё сохраняет `symbol` как технический primary key.
- [x] Добавить безопасное удаление пары из market universe: запрет при активном deployment
      или открытой позиции, явное поведение для immutable strategy versions, остановка
      новых subscriptions и сохранение уже накопленной истории.
- [ ] Обрабатывать изменение статуса и delisting инструмента: запрет новых входов,
      health incident, понятное состояние в UI и контролируемое закрытие/остановка runtime.
- [ ] Добавить reconciliation market history после разрыва WebSocket: поиск пропусков,
      REST-backfill недостающих свечей и контроль непрерывности данных до возобновления
      торговых сигналов.
- [x] Страница пары со свечами, EMA, RSI, ATR и regime.
- [x] Read-model позиций и завершённых сделок.
- [x] Страница открытых позиций и истории сделок.
- [x] Торговый контекст на Overview и странице пары.
- [x] Orders, fills и детальная страница сделки.
- [x] Полный overview projection с account snapshots.

## Этап 3 — Strategies и runtime

- [x] Strategy catalog и status model.
- [x] Секционный strategy editor.
- [x] Заменить ручной ввод торговых пар в редакторе стратегии на shadcn-compatible
      multi-select. Источником вариантов должен быть market universe текущего workspace;
      сохранять выбранные пары в immutable strategy version и явно обрабатывать пары,
      удалённые из рынка после создания версии.
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
- [x] Добавить управляемое сопровождение позиции: перенос защитного stop в безубыток с
      учётом комиссий и slippage после заданного R, отложенную активацию trailing-stop,
      выход EMA-стратегии по обратному пересечению и постоянный учёт лучшей цены позиции.
- [x] Провести параллельный dry-run нового managed-exit варианта против неизменённой
      `EMA Aggressive Both 30-100`; сравнивать только после минимального порога выборки.

## Этап 4 — Validation Center

- [x] Единая execution semantics runtime/backtest.
- [ ] Выделить versioned golden datasets и ожидаемые решения, сделки, PnL и метрики для
      проверки equivalence runtime/backtest на одинаковой последовательности событий.
- [ ] Зафиксировать funding policy: текущие конфликтующие funding-результаты считать
      invalid/disabled до новой воспроизводимой валидации; исключить зависимость расчёта
      от wall clock.
- [ ] Довести provenance всех метрик до единого контракта: environment, exchange,
      source, instrument type, dataset/config/engine versions и freshness.
- [x] Immutable dataset snapshots с content hash и повторным использованием исторических
      наборов без повторной загрузки.
- [x] Durable очередь ValidationRun/Job для backtest и walk-forward.
- [x] Run composer и мониторинг очереди в Validation Center.
- [x] Worker execution для backtest/walk-forward jobs.
- [x] Validation gates и provenance.
- [x] Run details и compare.

## Этап 5 — Analytics

- [x] Performance projections и breakdowns.
- [x] Рейтинг параллельных экспериментов: normalized return, realized/unrealized PnL,
      риск, экспозиция, фильтры и контроль достаточности выборки на 30/100/200 сделках.
- [x] Equity, drawdown и PnL calendar.
- [x] Распределения результата и времени в позиции.
- [x] Trade provenance и breakdowns по market regime и UTC-session.
- [x] Health, drift и watchdog.
- [x] Activity/explainability.
- [ ] Сохранить текущие конфигурации экспериментов неизменными до 30 закрытых сделок на
      стратегию, кроме исправлений доказанной ошибки исполнения или расчёта.
- [ ] На checkpoint 30 сделать формальный review и выбрать 3–5 кандидатов по net return,
      expectancy, drawdown, costs, стабильности по парам/режимам и достаточности выборки.
- [ ] Для отобранных кандидатов накопить 100+ закрытых сделок; окончательные решения
      принимать по неизменяемым версиям и отдельно сравнивать dry-run и Bybit Demo fills.

## Этап 6 — Разбор и polish

- [x] Journal и review sessions.
- [x] Playbooks.
- [x] System logs и settings.
- [x] Desktop accessibility, keyboard и performance review.
- [x] Перекомпоновать страницу «Настройки»: убрать смешение несвязанных блоков, собрать
      понятные разделы «Рабочее пространство», «Участники и доступ», «Биржи», «Торговля и
      риск», «Данные и хранение», «Безопасность» и «Система»; выстроить единые заголовки,
      описания, действия и навигацию между разделами без изменения бизнес-логики.
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
- [x] Пересобрать PnL-календарь как месячную календарную сетку: текущий месяц по
      умолчанию, навигация стрелками, количество сделок и дневной результат в каждой дате.
- [x] Унифицировать period/viewport для графика капитала на Overview и графиков капитала
      и просадки в «Аналитике»: всегда загружать полную историю без временной фильтрации;
      default `24h`; переключатели `24h / 7d / 30d` меняют только плотность и ширину
      видимого окна; ручные pan/zoom сохраняются до следующей смены масштаба. Отдельно
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
- [ ] Добавить onboarding нового workspace без seed/fake данных и полноценные empty states
      для рынка, стратегий, validations, runtime, аналитики и биржевых подключений.
- [ ] Добавить limits/quotas на параллельные deployments, размер market universe,
      исторические datasets и тяжёлые validation jobs.
- [ ] Завершить lifecycle пользовательских данных: полный экспорт, удаление аккаунта и
      workspace, retention policy, блокировка пользователя и audit событий этих операций.
- [ ] Удалить development access endpoints/config из клиентского deployment.
- [ ] Определить support/incident workflow и окончательно утвердить достаточность ролей
      `OWNER`/`MEMBER` до добавления новых ролей.
- [x] Multi-workspace scheduling для runtime/account/watchdog worker.
- [x] Workspace-scoped exchange connections и encrypted credentials.
- [x] Проверка credentials через Bybit, permission policy и lifecycle статусов.
- [x] Привязка deployment к проверенному exchange connection и fail-closed runtime gate.
- [x] Периодическая перепроверка exchange connection с lease, retry и health incidents.
- [x] Миграция development workspace к владельцу.

## Этап 9 — Production readiness и Bybit Demo

- [ ] Подготовить постоянное окружение вне ноутбука: server/VPS, HTTPS, домен, закрытая
      административная поверхность и воспроизводимый deployment/rollback runbook.
- [ ] Добавить CI для typecheck, lint, build, проверки Prisma migrations и сборки Docker
      images; не выполнять автоматический production deploy без отдельного решения.
- [ ] Автоматизировать регулярные PostgreSQL backups, retention, проверку восстановления и
      оповещение о неуспешном backup/restore check.
- [ ] Реализовать доставку критичных watchdog/outbox уведомлений минимум в один внешний
      канал: stale market data, остановка worker, runtime failure, rejected order,
      превышение risk limit и недоступность биржи.
- [ ] Добавить versioned master-key rotation для encrypted exchange credentials и runbook
      восстановления/повторной привязки ключей.
- [ ] Реализовать portfolio risk для общего биржевого аккаунта: capital allocation,
      reservation, конфликт long/short по символу, aggregate exposure/correlation limits,
      order/position attribution и приоритеты стратегий.
- [ ] Добавить независимый risk guard: max position/account exposure, max concurrent
      positions, daily loss limit, stale-data gate и глобальный kill switch.
- [ ] Реализовать Bybit Demo execution adapter: create/amend/cancel orders, exchange order
      ids, fills/fees, exchange-native SL/TP и идемпотентные client order ids.
- [ ] Реализовать reconciliation demo-account: balances, positions, open orders и fills;
      восстановление после рестарта, обработка частичного исполнения и расхождений между
      локальным ledger и Bybit.
- [ ] Сопоставить dry-run fill/slippage model с фактическими Bybit Demo fills и повторно
      валидировать параметры costs до решения о live readiness.
- [ ] Провести отдельный operational readiness review перед любым `LIVE` deployment:
      security, risk limits, reconciliation, backup, alerts, rollback и ручной kill switch.

## Этап 10 — Landing

- [ ] Marketing app.
- [ ] Product, methodology и docs.
- [ ] Public track-record projection.
- [ ] Signup/waitlist и pricing после отдельных решений.

## Идеи

- Team roles beyond owner/member.
- Billing.
- AI assistant.
- Marketplace.
- Multi-exchange.
- Управляемое самообучение стратегий по плану `docs/rebuild/11-SELF-LEARNING-MODELS.md`.
