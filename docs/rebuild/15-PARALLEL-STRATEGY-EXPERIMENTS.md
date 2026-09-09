# Параллельные эксперименты стратегий

Актуально на 2026-09-09. Контур остаётся `dry-run`: приватные ордера на Bybit не
отправляются.

## Цель

Запускать несколько воспроизводимых стратегий одновременно, собирать независимые сделки
и затем использовать данные для создания более устойчивой общей модели. Каждый вариант
должен иметь immutable config, backtest, walk-forward, отдельный execution run и
изолированный виртуальный капитал.

## Активный набор

| Стратегия                      | Пары           | TF  | Сигнал / вход            | Риск; SL/TP    | Backtest                       | Walk-forward                  |
| ------------------------------ | -------------- | --- | ------------------------ | -------------- | ------------------------------ | ----------------------------- |
| EMA Trend Baseline             | BTC, ETH       | 15m | long 50/200, market      | 0,25%; 2/6%    | 46 сделок; PF 1,59; +475,52    | 32 сделки; PF 1,42; +223,95   |
| EMA Trend Core 3               | BTC, ETH, LINK | 15m | long 50/200, market      | 0,25%; 2/6%    | 73 сделки; PF 1,55; +704,50    | 53 сделки; PF 1,36; +324,44   |
| EMA Core Fast 30-100           | BTC, ETH, LINK | 15m | long 30/100, market      | 0,25%; 2/6%    | 115 сделок; PF 1,49; +1 032,37 | 77 сделок; PF 1,29; +378,31   |
| EMA Core Limit 50-200          | BTC, ETH, LINK | 15m | long 50/200, limit 5 bps | 0,25%; 2/6%    | 62 сделки; PF 1,72; +731,99    | 43 сделки; PF 1,52; +367,03   |
| EMA Aggressive Both 30-100     | BTC, ETH, LINK | 15m | both 30/100, market      | 1%; 3/9%       | 81 сделка; PF 1,32; +1 989,87  | 55 сделок; PF 1,32; +1 226,00 |
| EMA Research Trend 20-50       | BTC, ETH, LINK | 15m | long 20/50, market       | 0,25%; 4/12%   | 54 сделки; PF 1,44; +389,40    | 47 сделок; PF 1,37; +245,06   |
| EMA 4H Slow 60-240 Long        | 8 пар          | 4h  | long 60/240, market      | 0,5%; 10/30%   | 63 сделки; PF 1,54; +1 184,72  | 45 сделок; PF 1,48; +692,11   |
| EMA 4H Medium 50-100 Both      | 8 пар          | 4h  | both 50/100, market      | 0,35%; 8/24%   | 158 сделок; PF 1,31; +1 258,56 | 102 сделки; PF 1,28; +699,66  |
| EMA 4H Alternative 27-125 Long | 8 пар          | 4h  | long 27/125, market      | 0,25%; 12/36%  | 92 сделки; PF 1,42; +677,07    | 59 сделок; PF 1,67; +572,52   |
| EMA 1H Medium 20-50 Both Wide  | 8 пар          | 1h  | both 20/50, market       | 0,25%; 6/18%   | 300 сделок; PF 1,13; +697,83   | 212 сделок; PF 1,19; +674,20  |
| EMA 15M Dual 25-75 Both        | BTC, ETH, LINK | 15m | both 25/75, market       | 1%; 3/9%       | 88 сделок; PF 1,37; +2 589,49  | 59 сделок; PF 1,14; +585,14   |
| EMA 15M Tight 30-100 Long      | BTC, ETH, LINK | 15m | long 30/100, market      | 0,5%; 1,5/4,5% | 148 сделок; PF 1,20; +1 217,31 | 96 сделок; PF 1,10; +363,36   |

У каждого deployment собственные 10 000 USDT dry-run капитала. Portfolio snapshot
агрегирует двенадцать account и начинает со 120 000 USDT.

Важно: это двенадцать независимых исполнений, но пока одна алгоритмическая семья —
EMA-crossover с RSI/ATR-фильтрами. Разные timeframe, направления, окна, тип входа и риск
дают полезный срез устойчивости параметров, но не заменяют независимые breakout,
mean-reversion и momentum-модели.

## Новые эксперименты 2026-09-09

### Набор 4h / 1h / 15m

Добавлены шесть конфигураций на трёх горизонтах. Для 4h использован snapshot за
2023-09-01 — 2026-08-31 (52 608 свечей, восемь пар), для 1h — 2024-09-01 —
2026-08-31 (140 160 свечей, восемь пар), для 15m — 2026-03-01 — 2026-08-31
(52 992 свечи, три пары). Все варианты прошли backtest и последовательный walk-forward
на том же immutable snapshot и cost model.

Подбор не является копированием готовой доходной стратегии. Исследования использованы
только как основание проверить trend-following, разные EMA-окна и более длинные
timeframe. Собственные gates CryptoAnal остаются обязательными.

Источники:

- [Technical trading and cryptocurrencies (Expert Systems with Applications, 2024)](https://doi.org/10.1016/j.eswa.2023.121806) — среди проверенных вариантов есть 4h и EMA crossover 20/50, 50/100 и другие окна;
- [A Decade of Evidence of Trend Following Investing in Cryptocurrencies](https://arxiv.org/abs/2009.12155) — долгосрочная проверка trend-following на криптовалютах;
- [Technical trading rules in the cryptocurrency market](https://doi.org/10.1016/J.FRL.2019.08.011) — эмпирическая проверка moving-average и trading-range правил для Bitcoin.

### EMA Aggressive Both 30-100

- цель: собирать отдельные long/short решения и проверить поведение риск-контуров;
- риск: 1% капитала на сделку, до трёх одновременных позиций, дневной stop 6%;
- выход: stop-loss 3%, take-profit 9%;
- walk-forward max drawdown: 7,98%; backtest max drawdown: 10,31%;
- стратегия намеренно не объединена с основным портфелем и не разрешена для demo/live.

### EMA Research Trend 20-50

Это не копия чужой стратегии и не обещание доходности. Вариант адаптирует простой
moving-average trend-following класс, исследованный Brock, Lakonishok и LeBaron, под
доступную execution schema CryptoAnal. Отдельная работа по криптовалютам также тестировала
SMA/EMA/DEMA crossover и walk-forward, но отмечала нестабильность внутридневных вариантов.
Поэтому конфигурация принята только после собственного backtest и walk-forward на тех же
комиссиях и свечах, что использует runtime.

Источники:

- [Simple Technical Trading Rules and the Stochastic Properties of Stock Returns](https://doi.org/10.1111/j.1540-6261.1992.tb04681.x);
- [Time Series Momentum](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2089463);
- [A Decade of Evidence of Trend Following Investing in Cryptocurrencies](https://arxiv.org/abs/2009.12155).

## Отрицательные результаты

- Простое ускорение EMA-crossover до 5m не прошло gates ни в одном проверенном варианте.
- Шесть пар, EMA 20/50, both, узкие выходы и trailing: 1 568 сделок, PF 0,54,
  −3 066,83 USDT, drawdown 30,92%.
- Более широкие SL 2% / TP 6% снизили потери, но лучший 5m-вариант остался около нуля:
  185 сделок, PF 1,00, −10,51 USDT.
- Limit-вход на выбранных трёх 5m-парах не исправил edge: PF 0,93, −105,70 USDT.
- 15m universe из восьми пар дал 250 сделок, но PF 0,88 и −606,79 USDT. Положительный
  вклад сохранили BTC, ETH и LINK; остальные пары не перенесены в активное ядро.
- Двусторонний 15m 50/200 на BTC/ETH/LINK не прошёл: PF 0,95, −106,08 USDT.
- Первичный 4h long 20/50 на восьми парах дал 196 сделок, но только PF 1,08 и
  drawdown 19,50%; вариант архивирован до walk-forward.
- Первичный 1h both 20/50 с SL 4% / TP 12% дал 551 сделку, PF 0,88 и
  −1 897,76 USDT; расширение выхода до 6% / 18% прошло оба этапа.
- Trailing-stop 2–8% ухудшил протестированные 1h и 4h конфигурации: варианты либо
  получили отрицательное ожидание, либо не достигли PF 1,10 в walk-forward.
- Быстрый 4h both 2/20 прошёл общий backtest с PF 1,17, но провалил walk-forward:
  PF 0,91 и −144,85 USDT.

Не прошедшие стратегии архивированы, но их ValidationRun и DatasetSnapshot сохранены как
negative research results.

## Правила сравнения

1. Сравнивать варианты на одинаковых исторических snapshot и cost model.
2. Не повышать стратегию до deployment без passed backtest и walk-forward.
3. Считать отдельно PF, expectancy, drawdown, fees, fill rate, частоту и вклад каждой пары.
4. Для live-наблюдения сравнивать одинаковые календарные периоды, а не абсолютное число
   сделок с момента старта.
5. Не объединять сигналы до накопления достаточного числа независимых live dry-run сделок.
6. Не выбирать итоговую конфигурацию только по лучшему PF из текущей сетки: это создаёт
   selection bias. Финальный кандидат обязан пройти новый holdout и forward dry-run.

## Следующий этап

- накопить минимум 30 закрытых dry-run сделок на каждый активный вариант;
- добавить сравнение runtime-вариантов по strategy account и одинаковому периоду;
- оценить корреляцию одновременных входов и долю одинаковых сделок;
- определить ensemble policy: голосование, ranking или выбор стратегии по regime;
- расширить execution schema независимыми signal families: breakout, mean-reversion и
  momentum; не маскировать новые EMA-параметры под новые алгоритмы;
- только после этого проектировать общий account allocation и demo execution.
