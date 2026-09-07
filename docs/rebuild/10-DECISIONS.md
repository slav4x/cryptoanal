# Зафиксированные и отложенные решения

## 1. Зафиксировать сейчас

### D-001. Название продукта — CryptoAnal

Новое имя используется в rebuild-спецификации, UI copy и будущей структуре проекта.

### D-002. Порядок — dashboard, users/workspaces, landing

Полноценный dashboard является первым продуктовым результатом. Auth и клиентская
изоляция добавляются после стабилизации его workflows. Лендинг строится последним.

### D-003. Demo dashboard не создаётся

Нет отдельного read-only `/demo` и параллельного demo data layer. Первый интерфейс —
настоящий закрытый dashboard.

### D-004. P0 работает в одном development workspace

Все user-owned данные уже имеют `workspaceId`. `RequestContext` возвращает фиксированный
workspace/actor до появления реальной session-based identity.

### D-005. Env login/password — временный access gate

Gate защищает закрытый стенд, но не моделирует пользователя и не упрощает саму auth
логику. Предпочтение: reverse-proxy Basic Auth; если нужен UI — server-side hash +
`HttpOnly` cookie. Browser env/localStorage запрещены.

### D-006. Design system — shadcn + semantic tokens

shadcn components хранятся в контролируемом UI package. Цвет, типографика, радиусы,
density, charts и sidebar управляются CSS variables. Feature pages не задают raw colors.

### D-007. Dashboard остаётся React/Vite

Это соответствует текущему продукту и не требует framework migration ради лендинга.
Marketing app позже выбирает свой SSR/SSG framework независимо.

### D-008. API и worker отделены от dashboard

Dashboard не обращается к exchange/DB. API — boundary/use cases, worker — runtime/jobs.

### D-009. Runtime/backtest имеют общую execution semantics

Различия среды задаются adapters/policies. Дублирование торговой логики считается
архитектурной ошибкой.

### D-010. StrategyVersion immutable

Run, deployment, position и trade всегда указывают точную версию/config hash.

### D-011. Multi-strategy не заявляется до реального исполнения

Data model может быть готова к нескольким deployments, но P0 поддерживает один активный
deployment на execution account до реализации allocation/conflict/risk attribution.

### D-012. Journal и playbooks входят в dashboard

Они остаются, поскольку дополняют анализ, но только как связанные с strategy/run/trade
рабочие инструменты. Social/marketplace/AI-функции не входят.

### D-013. Public surface откладывается до landing

Track record, methodology и public API не входят в P0. Позже они строятся отдельными
whitelist projections, а не раскрывают private runtime DTO.

### D-014. Один источник правды

Strategy status и validation verdict не дублируются вручную между README/catalog/template.
Документы описывают правила, а фактический статус идёт из versioned data.

### D-015. Legacy-история остаётся архивом

Автоматический импорт из `crypto-trade` не выполняется: старые стратегии, validation,
решения и сделки не удовлетворяют текущим config/provenance contracts. Новая история
начинается в чистом `development` workspace. Отдельная стратегия при необходимости
воссоздаётся вручную как draft и проходит новую validation.

## 2. Рекомендации, не требующие решения сейчас

### Package manager

Для нового monorepo рационален pnpm workspaces. Зафиксировать при создании skeleton.

### ORM

Prisma можно сохранить: основной долг находится в ownership/schema/repository patterns,
а не в самом ORM. Менять только при конкретном ограничении.

### Jobs

Начать с PostgreSQL-backed queue/lease или существующего надёжного job library. Не
вводить Redis/BullMQ без нагрузки, требующей отдельной очереди.

### Realtime UI

Начать с TanStack Query polling по разным freshness policies. SSE/websocket добавлять
только для реального live tail/progress, а не для каждого показателя.

### Development access

Для одного стенда reverse-proxy Basic Auth проще и надёжнее application fake auth.
Минимальная login page нужна только если удобство важнее дополнительного кода.

## 3. Решить перед users/workspaces

- email/password, magic link или внешний identity provider;
- personal workspace автоматически или явное создание;
- нужен ли multi-member workspace в первом клиентском релизе;
- роли и список permission;
- session TTL/device management;
- invitation/recovery flows;
- credential encryption/key management;
- policies удаления, экспорта и блокировки аккаунта.

## 4. Решить перед landing

- ICP и основной обещаемый outcome;
- self-service signup или waitlist;
- pricing/billing model;
- какие стратегии/метрики разрешены публично;
- задержка/агрегация track record;
- legal/risk/privacy copy;
- docs/public API scope;
- framework для `apps/marketing`.

## 5. Решить перед multi-strategy

- allocation model;
- capital reservation;
- conflict policy для одного symbol/account;
- aggregate exposure/correlation limits;
- order/position attribution;
- independent pause/stop;
- performance attribution;
- failure isolation и fairness scheduling.

## 6. Definition of ready для users/workspaces

- dashboard workflows и routes стабильны;
- все user-owned tables уже имеют `workspaceId`;
- repository/use-case signatures принимают `RequestContext`;
- global data явно классифицированы;
- fixed development workspace мигрируется предсказуемо;
- secrets не находятся на клиенте;
- audit events существуют для управляющих действий.

## 7. Definition of ready для landing

- P1 используется реальными тестовыми клиентами;
- onboarding и empty workspace не требуют ручной работы;
- сформулирована подтверждённая ценность;
- public projection спроектирована независимо от private API;
- claims можно подтвердить данными;
- auth/private routes не зависят от marketing app.

## 8. Definition of ready для live money

- paper/demo runtime стабилен;
- runtime/backtest equivalence подтверждена;
- risk limits и kill switch проверены;
- persistence/outbox/reconciliation надёжны;
- exchange credential isolation готова;
- monitoring, incident response, backup/restore работают;
- пользователь явно подтверждает environment и риски.
