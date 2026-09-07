# Auth, users и изоляция workspaces

> Статус: актуальная реализованная архитектура на 2026-09-08. Следующие auth-срезы явно
> перечислены в конце документа.

## 1. Принятый scope

Первый клиентский контур использует собственную email/password авторизацию без публичной
регистрации. Первого владельца создаёт администратор. Остальные пользователи входят в
продукт только по одноразовому приглашению владельца workspace.

Реализовано сейчас:

- `User`, `Session`, `WorkspaceMembership` и роли `OWNER`/`MEMBER`;
- Argon2id для паролей;
- opaque server-side session в `HttpOnly` cookie;
- hash session token в PostgreSQL вместо сырого токена;
- активный workspace в session и переключение только по membership;
- session-based `RequestContext` для всех private API;
- CSRF-защита всех изменяющих private запросов;
- точный CORS origin, security headers и rate limit на login;
- audit events для создания/отзыва session и переключения workspace;
- login/logout UI, реальный пользователь и workspace switcher;
- создание отдельного workspace с owner membership, настройками и немедленным переключением;
- owner-controlled invitations, принятие приглашения и создание пользователя;
- список участников, смена ролей, удаление участника и отзыв его активных sessions;
- защита от удаления или понижения последнего владельца.

Не входят в этот срез: public signup, email verification, recovery, device management,
SSO и billing. Exchange credentials описаны отдельно в `14-EXCHANGE-CONNECTIONS.md`.

## 2. Модель данных

```text
User 1 ── * WorkspaceMembership * ── 1 Workspace
User 1 ── * Session * ── 1 active Workspace
Workspace 1 ── * WorkspaceInvitation
Workspace 1 ── * domain entities
```

`User` хранит нормализованный уникальный email, display name, Argon2id hash и флаг
блокировки. `WorkspaceMembership` является единственным источником доступа пользователя
к workspace. `Session.activeWorkspaceId` только запоминает текущий выбор и не заменяет
проверку membership.

Сырой session token существует только в cookie браузера. В `Session.tokenHash` хранится
SHA-256. Отзыв выполняется через `revokedAt`, срок жизни — через `expiresAt`.

`WorkspaceInvitation` содержит нормализованный email, роль, SHA-256 одноразового token,
срок жизни семь дней, автора и результат принятия/отзыва. Сырой token возвращается только
один раз при создании ссылки и никогда не хранится в БД.

## 3. Request flow

1. API читает opaque token из `cryptoanal_session`.
2. По hash находит неистёкшую и неотозванную session активного пользователя.
3. Проверяет membership для `activeWorkspaceId`.
4. Строит context: `actorId`, `workspaceId`, role, session и список доступных workspaces.
5. Предметный endpoint передаёт только workspace из context в repository.
6. Для `POST`/`PUT`/`PATCH`/`DELETE` дополнительно проверяется HMAC CSRF token.

`workspaceId` из body/query никогда не выбирает tenant для предметного endpoint. Исключение
— команда переключения workspace: она сначала проверяет membership и только затем меняет
session.

## 4. API

```text
GET  /api/v1/auth/session
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/workspace
POST /api/v1/workspaces
GET  /api/v1/workspaces/:workspaceId/access
POST /api/v1/workspaces/:workspaceId/invitations
DELETE /api/v1/workspaces/:workspaceId/invitations/:invitationId
PATCH /api/v1/workspaces/:workspaceId/members/:userId
DELETE /api/v1/workspaces/:workspaceId/members/:userId
GET  /api/v1/invitations/:token
POST /api/v1/invitations/:token/accept
GET  /api/v1/context
```

`/health`, login, чтение session и точные invitation routes публичны. Все остальные
`/api/v1/*` требуют session. Создание/отзыв приглашений и управление ролями требуют
`OWNER`; список доступен всем участникам текущего workspace.
Неавторизованный запрос получает `401 AUTH_REQUIRED`, запрещённый workspace —
`403 WORKSPACE_ACCESS_DENIED`, неверный CSRF — `403 CSRF_TOKEN_INVALID`.

## 5. Bootstrap первого владельца

После seed нужно один раз создать владельца существующего development workspace:

```bash
CRYPTOANAL_NEW_USER_PASSWORD='use-a-long-local-password' \
  pnpm auth:create-user --email owner@example.com --name 'Owner' --workspace development
```

Пароль передаётся процессу через environment, не попадает в argv, Git или базу в открытом
виде. Команда не перезаписывает существующего пользователя.

## 6. Инварианты изоляции

- membership проверяется до выдачи context;
- repositories получают обязательный `workspaceId`;
- lookup по ID дополнительно ограничивается `workspaceId`;
- composite unique constraints локальны для workspace;
- audit/system logs пишутся в workspace текущей session;
- session другого пользователя не даёт возможности выбрать чужой workspace;
- глобальные market instruments/candles являются общими справочными данными, но watchlist,
  стратегии, validations, runtime, сделки, журнал, playbooks и settings изолированы.

Worker получает список operational workspaces через memberships активных пользователей и
изолированно обрабатывает для каждого account snapshots, runtime targets и watchdog
incidents. Ошибка одного workspace не прерывает цикл остальных. Рыночные snapshots и
candles остаются общими справочными данными. Биржевые подключения также принадлежат
workspace и не доступны через session другого tenant.

## 7. Invite-only onboarding

1. Владелец создаёт ссылку в `/settings`; предыдущее активное приглашение на тот же email
   отзывается.
2. Новый пользователь задаёт имя и пароль длиной не менее 12 символов. Существующий
   пользователь подтверждает текущий пароль.
3. API атомарно создаёт membership, помечает token использованным и открывает session в
   приглашённом workspace.
4. Участник не может приглашать, менять роли и удалять людей. Владельца сначала нужно
   понизить до member; последний owner защищён.
5. При удалении membership все активные sessions пользователя в этом workspace отзываются.

Отправка email пока отсутствует: владелец вручную копирует одноразовую ссылку. Это
сознательная граница текущего development-среза.

## 8. Следующие auth-срезы

1. Recovery, email verification, password rotation и список устройств/session.
2. Permission matrix для `MEMBER` и дополнительных ролей при реальной необходимости.
3. Email delivery для приглашений.
4. Public signup только после отдельного решения о self-service onboarding.
