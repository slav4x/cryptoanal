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

## Checkpoint индикаторов — 4 октября 2026

Indicator engine 2.0.0, validation 0.6.0 и candle replay 1.2.0 используют общий
SMA-seeded EMA/Wilder RSI расчёт с JSON checkpoint. Контрольный dataset и его решения,
сделки, комиссии и PnL не изменены; обновлены только версии движков. На 1500 свечах
EMA, breakout, mean-reversion и momentum проверено точное равенство всех признаков и
сигналов между batch и пакетами 1/13/102/287 с восстановлением checkpoint после каждого
пакета. При разных начальных историях равенство не гарантируется: validation dataset
ещё предстоит связать с seed anchor runtime. Исправленная формула Z-score может изменить
mean-reversion решения старых исследований; сохранённые результаты не пересчитываются.

## Общая начальная история — 4 октября 2026

Runtime без сохранённого checkpoint инициализируется от полного immutable validation
snapshot из execution context. ID/hash и версия source validation сохраняются в anchor;
будущие, изменённые, отсутствующие и недостаточно прогретые данные отклоняются. Полный
snapshot плюс последующие свечи даёт одинаковые признаки с непрерывным расчётом всей
истории; проверены все четыре семейства и JSON restart. Legacy run без snapshot или с уже
сохранённым legacy checkpoint остаётся явно отделённым и не получает выдуманную историю.
Walk-forward 0.8.0 один раз считает индикаторы полного dataset и выбирает признаки для
каждого окна. Контрольный momentum fixture сохранил dataset, решения, сделки и метрики;
обновлена только версия validation engine. Исторические результаты source validation
0.2/0.3/0.4 не пересчитываются; новая версия seed не означает нового подтверждения их PnL.

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

Validation 0.8.0 отделяет прогрев от оценки: контрольный набор сохраняет 124 исходные свечи,
но metrics.candleCount = 26, warmupCandleCount = 98. Equity samples начинаются после прогрева;
три сделки, комиссии, net PnL 585.34513577, dataset hash и runtime decisions не изменены.
Новые UI validation загружают прогрев до выбранной даты и закрепляют его в snapshot.
Walk-forward считает только полные тестовые окна, без training и неиспользованного остатка.
