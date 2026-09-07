# Подключения бирж и шифрование credentials

> Статус: workspace-scoped хранение, API и управление в dashboard реализованы. Проверка
> credentials через Bybit и использование их runtime намеренно не включены в этот срез.

## 1. Граница текущей реализации

Владелец workspace может добавить Bybit connection для `demo` или `live`, заменить ключи
и отозвать подключение. Участник видит только metadata и статус. Создание live connection
не включает live trading: runtime по-прежнему работает только в `dry-run` и требует
отдельного будущего safety gate.

До проверки приватным Bybit API новое или обновлённое подключение имеет статус
`UNVERIFIED`. Статусы `ACTIVE` и `INVALID` зарезервированы для следующего lifecycle-среза.

## 2. Модель данных

`ExchangeConnection` принадлежит одному `Workspace` и хранит:

- provider, label и environment;
- статус и время последней успешной проверки;
- маску API key с четырьмя последними символами;
- версию формата шифрования;
- два независимых ciphertext для API key и API secret;
- автора, timestamps и признак отзыва.

Все запросы ограничены активным workspace из server-side session. `workspaceId` не
принимается из body. DB constraint запрещает `DRY_RUN` для приватного подключения. После
отзыва ciphertext обоих credentials немедленно заменяется на `NULL`; запись остаётся
только как lifecycle metadata, а действие — в audit trail.

## 3. Шифрование

- алгоритм: AES-256-GCM;
- master key: отдельный `EXCHANGE_CREDENTIALS_KEY`, base64 от 32 случайных байт;
- nonce: 12 случайных байт для каждого поля и каждой ротации;
- authentication tag: 16 байт;
- AAD связывает ciphertext с workspace, provider, environment и label;
- payload содержит собственную версию формата.

API никогда не возвращает ciphertext или расшифрованные значения. Request bodies,
headers и cookies не записываются в system logs; audit metadata содержит только provider,
environment и label. Production не запускается с development-ключом по умолчанию.

Создание ключа:

```bash
openssl rand -base64 32
```

Ключ хранится вне Git. Потеря ключа означает невозможность восстановить credentials;
компрометация требует ротации master key и всех биржевых API-ключей. Автоматическая
master-key rotation остаётся отдельной operational задачей.

## 4. API

```text
GET    /api/v1/exchange-connections
POST   /api/v1/exchange-connections
PUT    /api/v1/exchange-connections/:connectionId/credentials
DELETE /api/v1/exchange-connections/:connectionId
```

`GET` доступен member/owner и возвращает только metadata. Остальные операции требуют
`OWNER` и CSRF. Ротация всегда сбрасывает статус в `UNVERIFIED`.

## 5. Следующий срез

1. Проверка credentials через приватный Bybit endpoint с минимальными permissions.
2. Явная проверка запрета withdrawal permission и документированный API-key scope.
3. Статусы `ACTIVE`/`INVALID`, причина ошибки и безопасный ручной retry.
4. Привязка deployment к конкретному connection вместо строкового account id.
5. Отдельный подтверждаемый gate для demo, затем для live; live не включать автоматически.
6. Версионированная master-key rotation и runbook восстановления.
