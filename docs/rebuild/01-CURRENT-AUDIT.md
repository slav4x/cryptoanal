# Аудит текущего проекта

Дата аудита: 2026-09-05. Аудит выполнен по текущему checkout `master`, HEAD `a93c96f`.

## 1. Масштаб и состав

Текущий репозиторий одновременно содержит:

- TypeScript trading runtime для Bybit;
- Fastify API;
- PostgreSQL/Prisma persistence;
- React/Vite operator dashboard;
- Node backtest и walk-forward;
- отдельный Python research toolkit;
- auth/workspace-заготовку;
- journal/playbooks;
- незавершённый multi-strategy runtime;
- Telegram/ops/backup scripts;
- генератор публичного лендинга и track record;
- большой research/product backlog.

Фактические показатели:

| Область | Размер |
| --- | ---: |
| Dashboard source files | 86 |
| Bot source files | 114 |
| Research source/test files | 16 |
| UI routes | 14 предметных маршрутов + fallback |
| HTTP endpoints | 71 |
| Prisma models | 27 |
| Prisma migrations | 19 |
| Отслеживаемые строки кода/документации/SQL | около 47 800 |
| Документация и changelog | около 7 500 строк |

Это уже не MVP одного продукта. Это trading lab, операторская панель, публичный proof,
research notebook и заготовка SaaS в одном процессе и одной навигации.

## 2. Что сделано хорошо

### 2.1. Домен и исследовательский подход

- Есть явное разделение `domain / application / infrastructure / presentation`.
- Биржа скрыта за `ExchangeGateway`; Bybit-клиент можно подменять в тестах.
- Риск, индикаторы, торговые издержки, режим рынка и performance report вынесены в
  отдельные чистые сервисы.
- Backtest учитывает не только PnL, но и PF, expectancy, drawdown, R, MFE/MAE,
  режимы, сессии, причины входа/выхода.
- Walk-forward и holdout используются как реальные стоп-гейты, а не как маркетинговая
  галочка.
- Исследовательский журнал фиксирует отрицательные гипотезы. Это редкая и ценная часть
  проекта, которую надо сохранить как knowledge base.

### 2.2. Безопасность торгового исполнения

- `DRY_RUN=true` и `BOT_AUTOSTART=false` — безопасные дефолты.
- Есть лимиты риска, экспозиции, числа позиций, корреляций и дневного убытка.
- Есть сериализация торгового цикла и ручного закрытия.
- Bybit-клиент обрабатывает временные ошибки, time sync и permission failures.
- Состояние funding boundary сохраняется, чтобы рестарт не создавал повторный вход.
- Есть reconciliation demo-позиций с биржей и отдельные тесты реального исполнения.

### 2.3. Проверяемость и доверие

- `track-record` строится через whitelist-проекцию, а не отдаёт сырые позиции/ключи.
- Публичные формулировки не обещают доходность и содержат demo/risk disclaimer.
- Версии стратегий и diff — правильная основа воспроизводимости.
- В интерфейсе есть explainability: причины `HOLD/SKIP/OPEN/CLOSE`, режим рынка,
  market precheck и drift.
- Есть demo checkpoints, maker fill-rate и попытка сверять комиссии/funding.

### 2.4. UI

- Тёмная flat-система с нейтральным chrome и семантическими profit/loss/warning цветами
  выглядит уместно для профессионального trading-продукта.
- Полезны общие паттерны: `panel`, `StatCard`, empty/error/loading states, таблицы,
  `PnlCalendar`, свечной график, explainability timeline.
- Навигация сгруппирована по смыслу; desktop sidebar и mobile drawer уже существуют.
- Dashboard test suite покрывает ключевые действия, а не только snapshot-разметку.

### 2.5. Операции

- Есть graceful shutdown, watchdog с edge-triggered alerting, backup и health check.
- Секреты не отслеживаются Git; в репозитории находится только `.env.example`.
- Уведомления, digest и публикация track record отделены в scripts.

## 3. Критические проблемы

### 3.1. Без auth публичным становится управляющий API

`AUTH_ENABLED=false` является дефолтом. При этом открыты не только чтение, но и:

- запуск и пауза engine;
- одиночный торговый цикл;
- ручное закрытие позиции;
- создание, изменение, запуск и архивирование стратегий;
- запуск backtest/walk-forward;
- journal/playbook mutations.

CORS не является механизмом авторизации. Такой API нельзя публиковать как коммерческую
заготовку без auth. На dashboard-first этапе интерфейс и API должны оставаться в private
network либо за development access gate. Будущий public API создаётся отдельно и не
переиспользует управляющие маршруты.

### 3.2. Публично раскрываются счёт и параметры edge

`/api/status` отдаёт баланс, позиции, риск и большую часть параметров стратегии.
`/api/strategy-templates` возвращает полные конфиги с точными порогами. При выключенном
auth всё это доступно внешнему клиенту. В новом проекте public API должен отдавать
санитизированные проекции, а не runtime DTO.

### 3.3. Workspace существует только частично

`Strategy`, journal и playbooks имеют `workspaceId`, но основные торговые сущности
`BotState`, `Position`, `ClosedTrade`, `Decision`, `WatchdogSnapshot`, `BacktestRun` и
`WalkForwardRun` глобальны. `/api/report`, `/api/status` и runtime store также глобальны.

Следствие: текущая auth/workspace-обвязка создаёт впечатление multi-tenant системы,
но не обеспечивает изоляцию торговых данных. Переносить её нельзя.

### 3.4. Multi-strategy обещан моделью, но не runtime

Есть `ExecutionProfile`, allocations, conflict policy, arbitrator и capital allocation.
Однако composition root при multi-profile выбирает только первую ногу с наивысшим
приоритетом и передаёт её в single-strategy engine. Некоторые policy (`net`) прямо
трактуются как `block until engine support`.

Эти классы — полезная спецификация будущего, но не готовая функция. В новом v1 их не
должно быть ни в продуктовых обещаниях, ни в runtime schema.

### 3.5. Источники правды противоречат друг другу

Критичный пример: `STRATEGY.md` фиксирует, что funding-ветка на demo торговала
невалидированную реализацию и была выключена. Но каталог и `STRATEGY_TEMPLATES.md`
продолжают описывать funding carry как валидированный положительный шаблон.

Также root README, package versions, три changelog и product docs обновлялись независимо.
В итоге статус продукта нельзя надёжно определить из одного документа.

## 4. Архитектурные проблемы

### 4.1. Монолитные файлы и смешанные ответственности

- `trading-engine.ts` — около 2 331 строк;
- `server.ts` — около 1 601 строки и 71 endpoint;
- `backtest-runner.ts` — около 1 317 строк;
- `JournalPage.tsx` — около 1 155 строк;
- `StrategyEditorPage.tsx` — около 900 строк;
- frontend `types.ts` — около 706 строк.

Размер — симптом: файлы одновременно координируют use cases, преобразуют DTO, считают
метрики, управляют persistence и форматируют ошибки.

### 4.2. Global mutable config

Активная стратегия накладывается через `Object.assign(config, ...)`; engine читает
этот объект «вживую». Это мешает:

- воспроизводить конкретный run;
- выполнять два run параллельно;
- тестировать без утечки состояния между тестами;
- безопасно вводить workspace/tenant;
- гарантировать, что позиция управляется тем конфигом, с которым была открыта.

Нужен immutable `ExecutionContext`, привязанный к `strategyVersionId` и `runId`.

### 4.3. Memory-first persistence с полной перезаписью

`BotStore` хранит позиции и до 2 500 сделок в памяти. Любая мутация ставит в очередь
сохранение полного snapshot. Репозиторий в транзакции удаляет все позиции, создаёт их
заново и upsert-ит всю историю сделок.

Риски:

- стоимость записи растёт с историей;
- persistence failure проглатывается после `console.error`, а торговля продолжается;
- уведомление о закрытии вызывается до durable commit;
- один процесс остаётся единственным источником истины;
- горизонтальное масштабирование невозможно.

Нужны точечные транзакции, idempotency keys и outbox.

### 4.4. Runtime и backtest могут расходиться

Runtime и backtest имеют отдельные большие реализации управления сделкой. История
funding-ветки уже доказала реальный drift: разные сигнал, timeframe ATR и ценовой grid
полностью перевернули результат. Новый проект должен переиспользовать единый execution
model либо проверять equivalence golden-тестами на одном наборе событий.

### 4.5. Слишком широкий плоский StrategyConfig

Один объект смешивает:

- торговую вселенную;
- риск;
- сигнал;
- market precheck;
- режимы bear/bull/neutral;
- выход;
- модель издержек;
- forward-validation фильтры;
- корреляционные правила.

В нём десятки полей, включая research-only ветки, которые продукт не исполняет.
Клиентский builder неизбежно становится формой конфигурационного файла.

### 4.6. Слабый контракт API

- Request body часто приводится через `as`, а не валидируется схемой маршрута.
- Backend и frontend вручную дублируют типы.
- Нет OpenAPI как проверяемого контракта.
- Ошибки возвращаются в разных форматах.
- Списки часто отдаются целиком; cursor pagination есть только у logs.
- Тяжёлый backtest выполняется внутри HTTP request вместо фоновой job.

## 5. Проблемы frontend

### 5.1. Глобальный polling на любом маршруте

`App` безусловно вызывает `useTradingData`, который каждые 5 секунд загружает status,
trades, 250 decisions и полный report. Это происходит также на `/login` и публичном
`/track-record`. Отдельные страницы/виджеты запускают дополнительные интервалы.

Нужны route-level queries, общий cache, отключение polling на скрытой вкладке и разные
refresh policy для live status, истории и публичных страниц.

### 5.2. Нет route code splitting

Все страницы импортируются синхронно. Текущая production-сборка dashboard:

- JS: 823.33 kB minified;
- JS: 248.61 kB gzip;
- сборщик предупреждает о chunk больше 500 kB.

Для рабочего dashboard это всё равно лишний стартовый вес: overview не должен получать
код chart/editor/journal/logs до перехода на соответствующий маршрут.

### 5.3. Смешан продукт и операторская панель

Одна навигация содержит пользовательские результаты, raw logs, watchdog, ручной control,
settings-заглушки, research backtest, journal и playbooks без ясной иерархии. Полезные
функции не обязательно удалять: их нужно собрать вокруг основного цикла, а raw operations
вынести в вторичную группу «Система».

### 5.4. Архитектурная документация устарела

Dashboard README утверждает, что widgets не выполняют HTTP напрямую, но запросы находятся
в страницах и нескольких widgets. Перечень маршрутов также не соответствует приложению.

### 5.5. Непоследовательный язык

В одном экране смешаны русские заголовки и `Journal`, `Review sessions`, `Setup library`,
`Workspace`, `Backtest`, `Track record`. Допустимые отраслевые термины нужно определить,
остальное локализовать последовательно.

## 6. Проблемы данных и модели

- Деньги, цены и количества хранятся как `Float`/JavaScript `number`.
- Ключевые данные дублируются в колонках и `data Json`; источник правды неочевиден.
- `Position.branch` типизирован только как `funding`, хотя код использует `bear` как default.
- У сделки нет обязательных `workspaceId`, `strategyVersionId`, `runId` и provenance исполнения.
- У validation run нет обязательных `engineVersion`, `configHash`, `datasetId/asOf`.
- Статусы и policy хранятся строками с комментариями вместо DB enum/check constraints.
- Схема содержит уже неактуальные комментарии «позже», хотя соответствующие модели добавлены.
- 19 исторических миграций следует сохранить в старом проекте, но не переносить как стартовую
  цепочку новой БД: новый проект должен получить одну baseline migration.

## 7. Проблемы product scope

Текущий проект одновременно пытается быть:

- готовой стратегией;
- конструктором стратегий;
- research framework;
- portfolio operating system;
- публичным доказательством;
- journal/playbook системой;
- founder SaaS.

Самый сильный продуктовый тезис — validation-first platform. Самое ценное ядро dashboard —
связка strategy version, backtest/walk-forward, execution, analytics и explainability.
Journal/playbooks полезны как продолжение этого цикла; public track record и лендинг не
должны отвлекать от завершения рабочего dashboard.

## 8. Текущее качество сборки

Проверено в текущем окружении:

| Проверка | Результат |
| --- | --- |
| Dashboard tests | 46/46 прошли |
| Dashboard typecheck | прошёл |
| Dashboard production build | прошёл, есть warning по размеру bundle |
| Bot tests | 202 прошли, 1 тест упал; ещё 2 suite не загрузились |
| Bot/root typecheck | не прошёл |
| Research unittest | 4/4 прошли |

Две bot-suite не загрузились, потому что в текущем `node_modules` отсутствуют объявленные
в `package.json` зависимости `argon2` и `@fastify/cookie`. Установка зависимостей в рамках
аудита не выполнялась.

Реальный падающий тест `partial profit → trailing stop` зависит от текущей даты: позиция
открыта фиксированной датой 2026-06-15, а funding начисляется до `new Date()`. Чем позже
запускается тест, тем больше funding и тем вероятнее отрицательный PnL. Это подтверждает
необходимость инъекции Clock и запрета wall-clock внутри доменных расчётов.

В проекте нет собственных lint config, CI workflow, браузерного E2E и DB integration suite.

## 9. Вывод

Текущий проект ценен как доказательство идей и библиотека тестовых сценариев, но плох как
фундамент коммерческого приложения. Его нельзя переносить целиком. Рестарт должен сначала
дать полноценный закрытый dashboard в одном development workspace, затем настоящую
пользовательскую изоляцию и только потом public landing. Нужно сохранить:

- доменные правила и regression tests;
- validation methodology;
- whitelist track-record projection как задел позднего публичного этапа;
- explainability и визуальные паттерны;
- операционные инварианты.

Нужно пересобрать:

- границы продукта;
- модель данных;
- runtime context;
- API contracts;
- web information architecture;
- процесс фоновых jobs;
- документацию и источники правды.
