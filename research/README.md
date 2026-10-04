# Research integrity

Этот каталог хранит versioned golden fixtures для проверки детерминизма торгового
движка. Fixture содержит неизменяемую последовательность закрытых свечей, config,
SHA-256 датасета и ожидаемые решения, сделки, PnL, комиссии и итоговые метрики.

Проверка:

```bash
pnpm research:verify
```

Команда независимо воспроизводит candle-event runtime и backtest на одном наборе
событий, сравнивает их сделки и затем сверяет результат с golden snapshot. Она не
доказывает эквивалентность realtime quote path: для него потребуется отдельный
versioned fixture с котировками и точным порядком событий.

## Правила изменения fixtures

- существующий fixture не редактируется ради прохождения проверки;
- изменение execution semantics требует новой версии fixture или явно проверенного
  обновления expected output в том же commit;
- `datasetHash`, `engineVersion`, решения, сделки и метрики проверяются вместе;
- новый signal family или новое правило выхода должно получить сценарий с входом и
  закрытием позиции, а не только набор свечей без сделок;
- `--print` используется только для review рассчитанного результата:
  `pnpm research:verify -- --print`.

## Изменение прогрева — 4 октября 2026

Validation 0.5.0 и candle replay 1.1.0 запрещают входы до полного непрерывного 24h
объёма. `momentum-reversal.json` (schema v1) использует dataset
`momentum-reversal-with-continuous-24h-warmup@2`: добавлены 96 плоских 15m свечей
перед исходными 28. Проверено сохранение исходных трёх сделок, их времён, комиссий
и PnL 585.34513577. Обновлены hash, engine versions, candleCount (124) и equity samples;
семантика сделок и параметры стратегии сохранены. Короткий набор без прогрева теперь
даёт ноль сделок и отдельно проверяется runtime-тестом. Эта проверка не доказывает
равенство EMA/RSI при разных начальных точках истории.

## Funding policy

Funding имеет статус `disabled` (`cryptoanal-funding@disabled-v1`). Runtime сохраняет
нулевое значение, а Analytics и Experiments исключают legacy-сделки с ненулевым funding.
Funding нельзя включать в PnL и сравнение стратегий, пока не появится воспроизводимый
event stream с exchange timestamps, ставкой, позицией и cash flow для каждого события.

## Metrics provenance

Validation, Analytics и Experiments возвращают общий provenance-контракт:

- environment, exchange, source и instrument type;
- версии dataset, strategy config и engine;
- dataset/config hashes, если они однозначно определены;
- `asOf`, freshness и текущую funding policy.

Для смешанной runtime-выборки engine/config помечаются как `mixed`/`null`; это запрещает
выдавать агрегат за результат одной неизменяемой конфигурации.
