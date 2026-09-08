# Параллельные эксперименты стратегий

Актуально на 2026-09-09. Контур остаётся `dry-run`: приватные ордера на Bybit не
отправляются.

## Цель

Запускать несколько воспроизводимых стратегий одновременно, собирать независимые сделки
и затем использовать данные для создания более устойчивой общей модели. Каждый вариант
должен иметь immutable config, backtest, walk-forward, отдельный execution run и
изолированный виртуальный капитал.

## Активный набор

| Стратегия                  | Пары           | TF  | Сигнал / вход            | Backtest                       | Walk-forward                  |
| -------------------------- | -------------- | --- | ------------------------ | ------------------------------ | ----------------------------- |
| EMA Trend Baseline         | BTC, ETH       | 15m | long 50/200, market      | 46 сделок; PF 1,59; +475,52    | 32 сделки; PF 1,42; +223,95   |
| EMA Trend Core 3           | BTC, ETH, LINK | 15m | long 50/200, market      | 73 сделки; PF 1,55; +704,50    | 53 сделки; PF 1,36; +324,44   |
| EMA Core Fast 30-100       | BTC, ETH, LINK | 15m | long 30/100, market      | 115 сделок; PF 1,49; +1 032,37 | 77 сделок; PF 1,29; +378,31   |
| EMA Core Limit 50-200      | BTC, ETH, LINK | 15m | long 50/200, limit 5 bps | 62 сделки; PF 1,72; +731,99    | 43 сделки; PF 1,52; +367,03   |
| EMA Aggressive Both 30-100 | BTC, ETH, LINK | 15m | both 30/100, market      | 81 сделка; PF 1,32; +1 989,87  | 55 сделок; PF 1,32; +1 226,00 |
| EMA Research Trend 20-50   | BTC, ETH, LINK | 15m | long 20/50, market       | 54 сделки; PF 1,44; +389,40    | 47 сделок; PF 1,37; +245,06   |

У каждого deployment собственные 10 000 USDT dry-run капитала. Portfolio snapshot
агрегирует шесть account и начинает с 60 000 USDT.

## Новые эксперименты 2026-09-09

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

Не прошедшие стратегии архивированы, но их ValidationRun и DatasetSnapshot сохранены как
negative research results.

## Правила сравнения

1. Сравнивать варианты на одинаковых исторических snapshot и cost model.
2. Не повышать стратегию до deployment без passed backtest и walk-forward.
3. Считать отдельно PF, expectancy, drawdown, fees, fill rate, частоту и вклад каждой пары.
4. Для live-наблюдения сравнивать одинаковые календарные периоды, а не абсолютное число
   сделок с момента старта.
5. Не объединять сигналы до накопления достаточного числа независимых live dry-run сделок.

## Следующий этап

- накопить минимум 30 закрытых dry-run сделок на каждый активный вариант;
- добавить сравнение runtime-вариантов по strategy account и одинаковому периоду;
- оценить корреляцию одновременных входов и долю одинаковых сделок;
- определить ensemble policy: голосование, ranking или выбор стратегии по regime;
- только после этого проектировать общий account allocation и demo execution.
