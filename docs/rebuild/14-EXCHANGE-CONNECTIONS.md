# Подключения бирж и шифрование credentials

> Статус: workspace-scoped хранение, API, ручная проверка Bybit V5 и управление в
> dashboard реализованы. Использование credentials в runtime намеренно не включено.

## 1. Граница текущей реализации

Владелец workspace может добавить Bybit connection для `demo` или `live`, заменить ключи
и отозвать подключение. Участник видит только metadata и статус. Создание live connection
не включает live trading: runtime по-прежнему работает только в `dry-run` и требует
отдельного будущего safety gate.

Новое или обновлённое подключение имеет статус `UNVERIFIED`. Ручная проверка переводит
его в `ACTIVE` при успешной аутентификации и безопасных permissions либо в `INVALID` при
ошибке credentials, несовпадении окружения/IP allowlist или разрешении `Withdraw`.

## 2. Модель данных

`ExchangeConnection` принадлежит одному `Workspace` и хранит:

- provider, label и environment;
- статус и время последней успешной проверки;
- маску API key с четырьмя последними символами;
- версию формата шифрования;
- два независимых ciphertext для API key и API secret;
- автора, timestamps и признак отзыва.
- режим read-only/read-write, наличие trading permission и IP allowlist;
- безопасную сводку permission groups, код и сообщение последней проверки.

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
POST   /api/v1/exchange-connections/:connectionId/verify
DELETE /api/v1/exchange-connections/:connectionId
```

`GET` доступен member/owner и возвращает только metadata. Остальные операции требуют
`OWNER` и CSRF. Ротация всегда сбрасывает статус в `UNVERIFIED`.

Проверка использует официальный `GET /v5/user/query-api`: для GET подписывается строка
`timestamp + apiKey + recvWindow + queryString` через HMAC-SHA256. Demo направляется на
`api-demo.bybit.com`, live — на настраиваемый mainnet endpoint. Сетевой сбой, timeout или
rate limit возвращает `503` и не меняет прежний статус. Только окончательный ответ об
ошибке credentials сохраняется как `INVALID`.

Политика permissions:

- любое разрешение `Wallet.Withdraw` блокирует подключение;
- read-only ключ разрешён для будущего чтения account data, но помечается `без торговли`;
- торговая возможность определяется отдельно по `Order`, `SpotTrade`, `OptionsTrade` или
  `DerivativesTrade`;
- IP-адреса не сохраняются и не возвращаются — только boolean наличия allowlist.

Основание: [Bybit V5 authentication](https://bybit-exchange.github.io/docs/v5/guide),
[Get API Key Information](https://bybit-exchange.github.io/docs/v5/user/apikey-info) и
[официальные error codes](https://bybit-exchange.github.io/docs/v5/error).

## 5. Следующий срез

1. Привязка deployment к конкретному `ACTIVE` connection вместо строкового account id.
2. Отдельный подтверждаемый gate для demo, затем для live; live не включать автоматически.
3. Периодическая перепроверка статуса и уведомления об expiry/invalid credentials.
4. Версионированная master-key rotation и runbook восстановления.
