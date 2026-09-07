# Миграция данных из crypto-trade

> Статус: аудит, checksummed archive, mapping и backup/restore verification завершены.
> Автоматический импорт не выполнялся: подтверждённых записей с достаточным provenance — 0.

## 1. Решение

Старую PostgreSQL нельзя переносить таблица-в-таблицу. Новая схема требует доказуемой
связи `strategy version → validation dataset → execution run → position/trade`, которой в
legacy-записях нет. Автоматический импорт таких данных сделал бы новый dashboard внешне
полным, но фактически недостоверным.

Текущая политика:

1. источник читается в `REPEATABLE READ READ ONLY`;
2. бизнес-данные сохраняются в локальный gzip-архив с SHA-256;
3. техническая телеметрия не архивируется и не переносится;
4. target database не подключается на этапе аудита;
5. импорт разрешается только после отдельного детерминированного mapping для конкретного
   типа данных.

## 2. Снимок источника

Аудит выполнен 7 сентября 2026 года для локальной базы `crypto_trade` на порту 5433.
Fingerprint схемы:

`50ac2b6122cc7cd75ab5dd36aaab057a873824cebfd96720b05b23cefadebb23`

| Legacy entity    | Строк | Решение                                   |
| ---------------- | ----: | ----------------------------------------- |
| Workspace        |     1 | вручную сопоставить с `development`       |
| Strategy         |    11 | архив до преобразования config            |
| StrategyVersion  |    15 | архив: 0 из 15 проходят новую schema      |
| StrategyRun      |     2 | архив: нет полного execution provenance   |
| ClosedTrade      |    92 | архив: нет strategy version/execution run |
| Decision         | 18368 | архив: нет обязательных предметных связей |
| BacktestRun      |   139 | архив: нет immutable dataset/config hash  |
| WalkForwardRun   |    62 | архив: нет immutable dataset/config hash  |
| TradeNote        |    77 | архив: все body пустые                    |
| ReviewSession    |     1 | архив: период не задан                    |
| Playbook         |     1 | архив: нет обязательных правил            |
| PlaybookExample  |    77 | архив вместе с legacy-сделками            |
| AppLog           |  4651 | исключить как техническую телеметрию      |
| WatchdogSnapshot | 44681 | исключить как техническую телеметрию      |

Открытых legacy-позиций, тегов, правил плейбука и OI snapshots в источнике нет.

## 3. Mapping

| Legacy                       | CryptoAnal                                | Автоимпорт | Условие разблокировки                                            |
| ---------------------------- | ----------------------------------------- | ---------- | ---------------------------------------------------------------- |
| Workspace                    | существующий `development` Workspace      | нет        | зафиксировать merge policy без создания второго workspace        |
| Strategy + StrategyVersion   | Strategy + immutable StrategyVersion      | нет        | написать и проверить преобразователь flat config → schema v1     |
| StrategyRun                  | Deployment + ExecutionRun                 | нет        | восстановить version, config hash и validation provenance        |
| ClosedTrade                  | Position + Trade                          | нет        | доказуемо связать с ExecutionRun и StrategyVersion               |
| Decision                     | Decision                                  | нет        | восстановить execution/strategy/correlation provenance           |
| BacktestRun + WalkForwardRun | DatasetSnapshot + ValidationRun           | нет        | иметь фактические candles, content hash и версию engine          |
| TradeNote                    | JournalEntry                              | нет        | непустой текст и полезный target либо правило standalone-импорта |
| ReviewSession                | ReviewSession                             | нет        | валидный период, summary, learnings и next actions               |
| Playbook + rules/examples    | Playbook + PlaybookStrategy/PlaybookTrade | нет        | заполнить entry и invalidation rules, разрешить ссылки           |
| BotState                     | не переносится                            | нет        | это mutable runtime snapshot, а не каноническая история          |
| AppLog + WatchdogSnapshot    | не переносится                            | нет        | новая observability начинается с чистого состояния               |

Даже похожие поля не считаются эквивалентными автоматически. Например,
`atrStopMultiplier` нельзя без допущений превратить в `stopLossPercent`, а legacy-статус
`validated` нельзя сохранить без воспроизводимого ValidationRun.

## 4. Локальный архив

Команда:

```bash
pnpm migration:audit -- --source-env ../crypto-trade/bot/.env
```

Создаёт закрытый от Git каталог `var/legacy-migration/<batch-id>/`:

- `manifest.json` — fingerprint схемы, counts, validation и решения по таблицам;
- `archive.ndjson.gz` — legacy business records без `AppLog` и `WatchdogSnapshot`;
- оба файла создаются с правами `0600`;
- manifest содержит SHA-256 архива.

Контрольный снимок содержит 18 847 записей. Размер архива — 16 466 841 байт, SHA-256:

`259c9acdf4df530efa86958a24931c908c42308a2afbe73cd395515d02ebbff0`

Проверка целостности:

```bash
gzip -t var/legacy-migration/<batch-id>/archive.ndjson.gz
shasum -a 256 var/legacy-migration/<batch-id>/archive.ndjson.gz
```

Архив содержит торговую историю и параметры стратегий. Его нельзя коммитить, отправлять
в публичное хранилище или использовать как seed. Для долгого хранения нужен отдельный
зашифрованный backup.

## 5. Итоговое решение

Legacy-история остаётся только в архиве. В операционные таблицы CryptoAnal импортировано
0 записей: ни одна исполняемая запись не удовлетворяет новой модели provenance. Это
осознанный результат eligibility-аудита, а не незавершённая миграция.

Новая база начинает каноническую историю с чистого `development` workspace. Если позже
понадобится конкретная старая стратегия, она создаётся вручную как новый draft с review
каждого поля и повторной validation; legacy-статус `validated` не переносится.

Старый проект и остановленная legacy-БД используются только как read-only reference.
Новый API, worker и dashboard от них не зависят.
