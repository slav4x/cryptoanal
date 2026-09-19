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
