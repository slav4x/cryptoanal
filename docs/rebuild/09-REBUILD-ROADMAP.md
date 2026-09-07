# Этапы пересборки CryptoAnal

Порядок обязателен: **dashboard → users/workspaces → landing**. Этапы ниже описывают
результат, а не календарные сроки. Новый этап начинается после выполнения stop-gate
предыдущего.

## Этап 0. Зафиксировать знания и scope

- [ ] Заморозить старый репозиторий как reference.
- [ ] Составить inventory use cases/API/data/UI.
- [ ] Зафиксировать доменные инварианты и regression cases.
- [ ] Выделить golden datasets и формулы метрик.
- [ ] Разрешить конфликт по funding branch: invalid/disabled до новой валидации.
- [ ] Утвердить имя `CryptoAnal` и dashboard-first scope.
- [ ] Назначить один active source of truth по strategy status.

**Готово, когда:** старый код не нужен как неявная документация для ключевых правил.

## Этап 1. Foundation и дизайн-система

- [x] Создать monorepo skeleton: dashboard, API, worker, packages.
- [x] Настроить typed config и environment validation.
- [x] Создать `RequestContext` с fixed development workspace.
- [x] Поднять baseline PostgreSQL schema с ownership полями.
- [x] Настроить contracts/schema-first API skeleton.
- [x] Подключить shadcn/ui и перенести primitives в `packages/ui`.
- [x] Описать semantic design tokens, dark theme, typography и density.
- [x] Собрать AppShell, navigation, error/loading/empty/stale patterns.
- [x] Настроить route lazy loading и TanStack Query providers.
- [ ] Если стенд удалённый — поставить proxy/dev access gate.

**Готово, когда:** пустой, но целостный CryptoAnal shell использует токены и fixed
workspace context; private API нельзя случайно открыть без защиты.

## Этап 2. Markets, overview и trading data

- [x] Реализовать market data adapter и нормализованные snapshots.
- [x] Реализовать `/markets` и watchlist.
- [x] Реализовать `/markets/:symbol` со свечами и режимом; события остаются следующим срезом.
- [x] Реализовать canonical positions/trades storage и read-model.
- [x] Добавить read repository и API для orders/fills в контексте сделки.
- [x] Реализовать `/trades`.
- [x] Реализовать `/trades/:tradeId` с timeline исполнений.
- [x] Реализовать базовые overview projections и `/`.
- [x] Добавить route-level query/freshness policies.
- [ ] Связать environment/source/provenance со всеми показателями.

**Готово, когда:** dashboard даёт целостный обзор рынка, позиций и истории без global
polling и без прямого обращения UI к exchange.

## Этап 3. Strategy workspace и runtime controls

- [x] Ввести `Strategy`, immutable `StrategyVersion`, `Deployment` и `ExecutionRun`.
- [x] Разделить config на universe/signal/filters/risk/entry/exit/costs/schedule.
- [x] Реализовать каталог стратегий.
- [x] Реализовать секционный editor и создание первой версии.
- [x] Реализовать strategy workspace, создание последующих версий и diff.
- [x] Реализовать status transitions и validation eligibility.
- [x] Создавать immutable `ExecutionContext` при каждом start.
- [x] Реализовать start/pause/resume/stop как атомарные commands.
- [x] Реализовать manual close позиции как отдельную command.
- [x] Добавить confirmations, optimistic state, durable idempotency и audit events.
- [x] Поддерживать один активный deployment на account до multi-strategy readiness.
- [x] Подключить worker execution loop к running dry-run deployment.

**Готово, когда:** стратегию можно создать, версионировать и безопасно запустить из UI;
каждая позиция знает точную version/run.

## Этап 4. Validation Center

- [x] Выделить общую runtime/backtest execution semantics.
- [x] Материализовать immutable dataset snapshot с фактическими свечами и content hash.
- [x] Перевести backtest/walk-forward в asynchronous jobs.
- [x] Реализовать создание ValidationRun, durable Job и очередь статусов.
- [x] Реализовать Validation Center composer и список очереди.
- [x] Реализовать run detail, trades, charts и breakdowns.
- [x] Реализовать formal gates и понятные pass/fail reasons.
- [x] Реализовать compare нескольких runs.
- [x] Связать validation verdict и config hash с разрешением deployment.

**Готово, когда:** результат можно воспроизвести и объяснить, а UI не блокирует HTTP на
долгой проверке.

## Этап 5. Analytics, health и explainability

- [x] Реализовать performance projections и фильтры.
- [x] Реализовать equity/drawdown/PnL calendar.
- [x] Реализовать distributions результатов сделок.
- [x] Реализовать breakdowns по strategy/version/symbol/exit.
- [x] Добавить breakdowns по market regime и trading session после фиксации этих полей в trade provenance.
- [x] Реализовать costs analysis: fees/funding/slippage.
- [x] Реализовать decision/activity timeline.
- [x] Реализовать drift against validated baseline.
- [x] Реализовать health/watchdog/incidents.
- [x] Отделить product activity от raw system logs.

**Готово, когда:** пользователь отвечает из UI не только «сколько», но и «почему»,
«по какой версии» и «где результат начал отклоняться».

## Этап 6. Journal, playbooks, settings и dashboard polish

- [x] Реализовать journal entries и связи с предметными сущностями.
- [x] Реализовать review sessions.
- [x] Реализовать playbooks без marketplace/social функций.
- [x] Реализовать рабочие settings sections.
- [x] Реализовать system logs с cursor pagination/redaction.
- [x] Унифицировать терминологию и microcopy.
- [x] Проверить desktop accessibility и keyboard flows; mobile responsive отложен по решению владельца.
- [x] Разгруппировать перегруженную навигацию и убрать локальные стили базовых контролов.
- [x] Зафиксировать performance budgets и route-level query intervals.
- [x] Обновить product/operations documentation.

**Dashboard stop-gate:** все P0 workflows работают в едином интерфейсе; нет demo branch,
fake auth, глобальных user-owned данных и критичных действий вне audit/state model.

## Этап 7. Подготовка и миграция данных

Можно выполнять частями раньше, но завершать после стабилизации схемы dashboard.

- [x] Зафиксировать mapping старой БД в baseline schema.
- [x] Провести import eligibility: подходящих записей нет, operational import равен нулю.
- [x] Сохранить один чистый `development` workspace без создания legacy workspace.
- [x] Архивировать invalid/ambiguous business data отдельно с manifest и SHA-256.
- [x] Зафиксировать отсутствие imported projections; legacy-метрики остаются в архиве.
- [x] Проверить backup/restore в изолированном одноразовом PostgreSQL.
- [x] Перевести старый проект в логический read-only reference без runtime dependency.

**Готово, когда:** новый dashboard не зависит от старой schema/runtime для ежедневной
работы, а история либо перенесена, либо явно архивирована.

## Этап 8. Настоящие users и workspaces

- [ ] Выбрать auth approach/provider отдельным ADR.
- [ ] Добавить `User`, `Identity/Session`, `WorkspaceMembership`.
- [ ] Заменить development resolver на session-based `RequestContext`.
- [ ] Реализовать signup/login/logout/recovery и security flows.
- [ ] Реализовать workspace creation/switching/membership по подтверждённому scope.
- [ ] Проверить workspace scope каждого repository/query/job.
- [ ] Добавить user/workspace settings и audit log.
- [ ] Добавить exchange connections и encrypted credentials.
- [ ] Мигрировать development workspace к реальному owner.
- [ ] Удалить development access endpoints/config из клиентского deployment.

**Готово, когда:** у каждого клиента свой кабинет, стратегии, проверки, deployments,
сделки, journal/playbooks и настройки; cross-workspace доступ запрещён по умолчанию.

## Этап 9. Клиентский product hardening

- [ ] Onboarding без фиктивных данных.
- [ ] Empty states для нового workspace.
- [ ] Limits/quotas для тяжёлых validation jobs.
- [ ] Account/exchange connection lifecycle.
- [ ] Export/delete/retention policies.
- [ ] Support/incident workflow.
- [ ] Проверить, нужны ли owner/member roles или достаточно одного owner.
- [ ] Решить billing/pricing отдельным ADR.

**Готово, когда:** продукт можно отдавать ограниченной группе клиентов без ручного
доступа разработчика к каждому базовому сценарию.

## Этап 10. Landing и публичный контур

- [ ] Сформулировать позиционирование по реально работающему продукту.
- [ ] Создать отдельный `apps/marketing`.
- [ ] Реализовать landing/product/methodology/docs.
- [ ] Создать whitelist public track-record projection.
- [ ] Добавить delayed/aggregated public metrics и disclaimer.
- [ ] Связать CTA с реальным signup/waitlist flow.
- [ ] Добавить pricing только после решения monetization.
- [ ] Проверить, что private dashboard/API не попали в public surface.

**Готово, когда:** лендинг честно описывает P1 и не раскрывает account data, exact edge,
private strategies или управляющие endpoints.

## Stop-gates

- Нельзя начинать полноценную auth-модель до стабилизации ownership и workflows dashboard.
- Нельзя публиковать P0 dashboard без private network/access gate.
- Нельзя строить landing как замену незавершённому продукту.
- Нельзя запускать multi-strategy только потому, что schema содержит profile/allocations.
- Нельзя переносить стратегию со статусом validated при конфликтующих источниках.
- Нельзя разрешать live execution без отдельного operational readiness review.

## Ideas — не реализовывать без отдельного запроса

- multi-strategy portfolio allocation;
- team roles beyond owner/member;
- billing/subscriptions;
- AI assistant/coach;
- strategy marketplace;
- copy trading;
- notifications center;
- mobile app;
- multi-exchange;
- public API for partners;
- custom dashboards/widget builder.

## Рекомендуемая последовательность крупных deliverables

1. `foundation + shadcn token system`
2. `markets + trades + overview`
3. `strategy workspace + runtime controls`
4. `validation center`
5. `analytics + health + activity`
6. `journal + playbooks + settings + polish`
7. `legacy migration`
8. `auth + workspace isolation`
9. `client hardening`
10. `marketing site + public track record`
