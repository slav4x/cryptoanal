# CryptoAnal: план пересборки

> Текущий статус: dashboard и migration-этапы завершены. Users/workspaces, invite-only
> onboarding и encrypted exchange connections реализованы; сейчас проект находится на
> hardening P1 перед landing. Детальный прогресс — в `09-REBUILD-ROADMAP.md` и `TASKS.md`.

Этот каталог — рабочая спецификация нового проекта `CryptoAnal`. Пересборка начинается
не с лендинга и не с авторизации, а с полноценного рабочего dashboard: торговые пары,
сделки, стратегии, проверки, аналитика, объяснения решений и операционные инструменты.

## Зафиксированная последовательность

1. **Dashboard-first — завершён.** Рабочий продуктовый контур собран и стабилизирован.
2. **Users and workspaces — основной контур завершён.** Авторизация, изоляция, создание
   workspaces, invitations, member management, encrypted exchange connections и
   multi-workspace worker, periodic credential verification, recovery и session management
   готовы; остаются email delivery и продуктовый hardening.
3. **Landing-last — не начат.** Лендинг, публичная методология, тарифы и санитизированный
   track record строятся только после стабилизации клиентского P1.

Отдельного demo-dashboard не будет. Первый dashboard — настоящий рабочий интерфейс со
всеми необходимыми действиями. Базовая session-based авторизация и membership уже
реализованы; расширенные клиентские flows добавляются следующими срезами.

## Авторизация

Dashboard использует database users, Argon2id password hashes, server-side sessions,
`HttpOnly` cookie, CSRF и membership-based workspace resolver. Онбординг работает только
по одноразовым приглашениям владельца. Recovery использует короткоживущую одноразовую
ссылку администратора и отзывает все прежние sessions; public signup и email delivery пока
не реализованы.

## Что читать

1. [01-CURRENT-AUDIT.md](01-CURRENT-AUDIT.md) — сильные стороны и долги текущего проекта.
2. [02-PRODUCT-SCOPE.md](02-PRODUCT-SCOPE.md) — продуктовая цель и границы этапов.
3. [03-INFORMATION-ARCHITECTURE.md](03-INFORMATION-ARCHITECTURE.md) — карта dashboard и
   состав страниц.
4. [04-TECHNICAL-ARCHITECTURE.md](04-TECHNICAL-ARCHITECTURE.md) — структура приложений,
   модулей и зависимостей.
5. [05-DATA-AND-API.md](05-DATA-AND-API.md) — ownership, модель данных и API.
6. [06-UI-AND-DESIGN-SYSTEM.md](06-UI-AND-DESIGN-SYSTEM.md) — shadcn, токены и UX-правила.
7. [07-KEEP-REWRITE-REMOVE.md](07-KEEP-REWRITE-REMOVE.md) — что переносить, переписывать
   и оставлять в архиве.
8. [08-QUALITY-SECURITY-OPERATIONS.md](08-QUALITY-SECURITY-OPERATIONS.md) — требования к
   качеству, безопасности и эксплуатации.
9. [09-REBUILD-ROADMAP.md](09-REBUILD-ROADMAP.md) — этапы с критериями готовности.
10. [10-DECISIONS.md](10-DECISIONS.md) — принятые и отложенные решения.
11. [11-SELF-LEARNING-MODELS.md](11-SELF-LEARNING-MODELS.md) — отложенная архитектура
    автоподбора параметров, ML-моделей и контролируемого переобучения.
12. [12-LEGACY-DATA-MIGRATION.md](12-LEGACY-DATA-MIGRATION.md) — фактический inventory,
    mapping, архив и ограничения переноса старой PostgreSQL.
13. [13-AUTH-WORKSPACE-ARCHITECTURE.md](13-AUTH-WORKSPACE-ARCHITECTURE.md) — текущая
    session-модель, security boundaries и правила tenant isolation.
14. [14-EXCHANGE-CONNECTIONS.md](14-EXCHANGE-CONNECTIONS.md) — модель подключения бирж,
    шифрование credentials, проверка, deployment binding и ограничения runtime.
15. [15-PARALLEL-STRATEGY-EXPERIMENTS.md](15-PARALLEL-STRATEGY-EXPERIMENTS.md) — активные
    dry-run варианты, единые правила сравнения и отрицательные результаты исследований.

## Короткая формула продукта

> CryptoAnal — рабочая платформа для исследования, проверки, запуска и анализа
> криптоторговых стратегий с полной воспроизводимостью и объяснением каждого результата.

Главная ценность — не обещание доходности, а связный цикл:

`рынок → гипотеза → версия стратегии → backtest → walk-forward → запуск → сделки → анализ`.

## Что не делать раньше времени

- не строить demo-версию параллельно с настоящим dashboard;
- не начинать лендинг до стабилизации клиентского интерфейса;
- не создавать фиктивную SaaS-авторизацию ради формы входа;
- не добавлять billing, тарифы, marketplace, copy trading и mobile app;
- не переносить текущий проект каталог в каталог;
- не обещать полноценный multi-strategy runtime, пока он не исполняет несколько стратегий;
- не выставлять development dashboard и управляющий API в публичный интернет без защиты.

## Принцип пересборки

Переносить инварианты, проверенные сценарии, методологию и удачные UI-паттерны. Для
каждой части старого проекта должен быть один статус: `портировать`, `переписать`,
`оставить как reference`, `не переносить`.
