# Информационная архитектура dashboard

> Статус: основная карта реализована. Dashboard закрыт auth gate, sidebar показывает
> реального пользователя и workspace switcher, а `/settings` поддерживает создание
> workspace, участников, приглашения, encrypted exchange connections, deployment binding и
> periodic verification. Следующий срез — security/session management.

## 1. Общая модель

На dashboard-first этапе существует один интерфейс: закрытый рабочий CryptoAnal.
Отдельных `/demo` и публичного shell нет. Навигация организуется вокруг задач, а raw
операторские инструменты вынесены в группу «Система».

## 2. Целевая карта маршрутов

```text
/
/markets
/markets/:symbol
/trades
/trades/:tradeId
/strategies
/strategies/new
/strategies/:strategyId
/strategies/:strategyId/versions/new
/validation
/validation/:validationRunId
/validation/compare
/runtime
/analytics
/analytics/health
/activity
/journal
/playbooks
/system/logs
/settings
```

Не создавать отдельные маршруты только ради modal/drawer. Фильтры, табы и выбранные
сущности должны кодироваться в URL там, где ссылкой будут делиться или страницу обновлять.

## 3. Навигация

### Основная

- **Рабочая область** — главная, рынки, сделки, стратегии, валидация, запуск и аналитика.
- **Исследования** — активность, разбор и плейбуки.
- **Система** — состояние, системные логи и настройки.

Группа «Система» визуально вторична. Управление запуском собрано на одном маршруте, а
связанные действия из обзора и стратегии ведут в тот же workflow. Внизу sidebar находится
реальная session identity и выход, сверху — переключатель доступных workspaces.

## 4. Структура страниц

### 4.1. `/` — Обзор

Цель: за 10–20 секунд ответить «что сейчас происходит и требует ли это внимания».

Порядок блоков:

1. header: environment, exchange mode, freshness, runtime state;
2. главные действия: запустить/поставить на паузу/остановить с подтверждением;
3. KPI: equity, day PnL, total PnL, open exposure, active strategies;
4. alerts: stale data, risk stop, drift, failed jobs, disconnected exchange;
5. equity/PnL chart с переключателем периода;
6. открытые позиции;
7. активные deployments и их health;
8. последние решения и сделки;
9. watchlist snapshot.

Не размещать здесь editor, полные raw logs и десятки второстепенных коэффициентов.

### 4.2. `/markets` — Пары и watchlist

Цель: выбрать инструмент и увидеть его пригодность для стратегий.

- поиск и фильтры по quote asset, статусу, regime, liquidity и volatility;
- таблица: symbol, price, 24h change, volume, spread, volatility, regime, watchlist;
- saved views в будущем принадлежат workspace;
- действия: добавить/убрать из watchlist, открыть детали;
- freshness и источник market data.

### 4.3. `/markets/:symbol` — Карточка пары

- candlestick chart с timeframe и overlays;
- live market snapshot;
- текущий regime и индикаторы с объяснением;
- открытая позиция и pending decisions;
- сделки по паре;
- результаты стратегий по паре;
- события/решения timeline;
- quick link к validation с предзаполненным symbol.

График не должен смешивать live candles и backtest dataset без явной маркировки.

### 4.4. `/trades` — Позиции и история

- табы `Открытые` / `Закрытые`;
- фильтры: период, strategy, version, symbol, side, environment, exit reason;
- агрегаты по активному фильтру;
- таблица с server-side sorting/pagination;
- экспорт выбранного набора;
- ручное закрытие только для открытой позиции, с preview последствий и подтверждением.

### 4.5. `/trades/:tradeId` — Сделка

- идентичность: workspace, environment, account, strategy/version, execution run;
- entry/exit timeline и orders/fills;
- fees, funding, slippage и итоговый PnL;
- decision factors на входе и выходе;
- MFE/MAE и график цены;
- risk snapshot;
- связанные journal notes;
- raw payload только в диагностической секции.

### 4.6. `/strategies` — Каталог стратегий

- статусы: draft, validating, approved, deployed, paused, archived;
- карточка/таблица с active version, last validation, deployment state и health;
- фильтры по статусу, рынку и владельцу после P1;
- действия: создать, клонировать, архивировать;
- запрещено показывать «validated», если нет прошедшего validation gate.

### 4.7. `/strategies/:strategyId` — Strategy workspace

Одна страница с табами, а не несколько несвязанных редакторов:

- **Обзор:** назначение, status, active version, deployment и последние результаты;
- **Конфигурация:** структурированный editor по секциям universe/signal/risk/exit/cost;
- **Версии:** timeline, diff, author и причина изменения;
- **Валидация:** все runs и переход к Validation Center;
- **Запуски:** deployments, execution runs и controls;
- **Результаты:** агрегаты и breakdowns только этой стратегии.

Сохранение создаёт draft/version; публикация/запуск — отдельные явные действия.

### 4.8. `/validation` — Validation Center

Объединяет текущие разрозненные backtest и walk-forward экраны.

- новый run: strategy version, dataset, period, symbols, cost model, mode;
- очередь и статусы jobs;
- сравнение нескольких runs;
- gates: sample size, PF, expectancy, drawdown, stability, holdout/WF;
- список последних runs с provenance;
- фильтры по strategy/version/status/mode.

Backtest и walk-forward — типы одной validation-модели, но результаты не смешиваются.

### 4.9. `/validation/runs/:runId` — Результат проверки

- неизменяемый input summary;
- engine/config/dataset hashes;
- verdict и причины gate pass/fail;
- KPI и equity/drawdown charts;
- breakdowns по symbol, regime, session, side, exit reason;
- trades и outliers;
- walk-forward windows/holdout;
- compare action;
- ссылка на исходную StrategyVersion.

### 4.10. `/analytics` — Результаты

- глобальные фильтры: period, environment, strategy/version, symbol;
- KPI и equity/drawdown;
- PnL calendar;
- breakdowns и distributions;
- fees/funding/slippage;
- top/bottom contributors;
- сравнение backtest/demo/live только отдельными сериями;
- все виджеты используют один serializable filter state.

### 4.11. `/analytics/health` — Здоровье

- data freshness и exchange connection;
- execution errors и rejected orders;
- drift live против validated baseline;
- watchdog events;
- maker fill-rate, slippage и latency;
- active risk stops;
- разделение incident и informational notices.

### 4.12. `/activity` — Объяснимые решения

- timeline `OPEN/CLOSE/HOLD/SKIP/ERROR`;
- фильтры по стратегии, паре, outcome и причине;
- факторная карточка решения;
- ссылка на market snapshot, version, position/trade;
- correlation id для перехода к системным логам.

Это продуктовый audit trail. `/system/logs` — техническая диагностика; смешивать их нельзя.

### 4.13. `/journal` — Исследовательский журнал

- записи по дате, стратегии, версии, symbol и тегам;
- связь с validation run, trade и activity event;
- гипотеза, наблюдение, вывод, следующее решение;
- review sessions как сгруппированный разбор периода;
- без попытки стать универсальным note-taking приложением.

### 4.14. `/playbooks` — Плейбуки

- библиотека повторяемых setups/rules;
- условия применения и invalidation;
- примеры связанных сделок;
- version history после P1;
- связь со стратегиями без автоматического изменения их config.

### 4.15. `/system/logs` — Технические логи

- уровни, service, period, correlation id и full-text search;
- cursor pagination;
- redaction secrets;
- live tail включается вручную, а не постоянно;
- доступ позднее ограничивается ролью.

### 4.16. `/settings` — Настройки

Текущие секции:

- environment и runtime safety;
- exchange connection status без показа secrets;
- market data/timezone/display preferences;
- notifications;
- retention/export;
- system information;
- список workspaces и создание нового изолированного workspace.

Реализованы управление участниками, одноразовые приглашения и подключения Bybit с
зашифрованными credentials. Следующими добавляются sessions/security и проверка доступа
к бирже без включения торговли.

## 5. Глобальная структура страницы

Каждая предметная страница следует одному ритму:

1. title + короткий context;
2. primary action;
3. filters/time range;
4. summary;
5. основной рабочий контент;
6. secondary details;
7. loading/error/empty/stale state.

## 6. Судьба текущих маршрутов

| Текущий             | Новый                     | Решение                                |
| ------------------- | ------------------------- | -------------------------------------- |
| `/`                 | `/`                       | Пересобрать overview                   |
| `/trades`           | `/trades`                 | Сохранить, разделить open/history      |
| `/trades/:symbol`   | `/markets/:symbol`        | Исправить идентичность маршрута        |
| `/strategies`       | `/strategies`             | Пересобрать каталог                    |
| `/strategies/:id`   | `/strategies/:strategyId` | Разбить editor на табы/modules         |
| `/backtest`         | `/validation`             | Объединить validation workflow         |
| `/analytics`        | `/analytics`              | Сохранить и унифицировать filters      |
| `/analytics/health` | `/analytics/health`       | Сохранить                              |
| `/journal`          | `/journal`                | Сохранить как связанный workflow       |
| `/playbooks`        | `/playbooks`              | Сохранить как связанный workflow       |
| `/logs`             | `/system/logs`            | Понизить в навигации                   |
| `/settings`         | `/settings`               | Реализовать реальными секциями         |
| `/track-record`     | поздний public app        | Не включать в P0 навигацию             |
| `/login`            | dev gate / будущий auth   | Не делать фиктивную user-auth страницу |

## 7. Landing после users/workspaces

Будущий marketing app проектируется отдельно и не загружается вместе с dashboard.
Предварительные страницы: `/`, `/product`, `/methodology`, `/track-record`, `/pricing`,
`/docs`. Их контент фиксируется только по фактически готовому P1 продукту.
