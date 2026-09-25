# AI Decision Lab: движок и LLM-интеграция

## Статус и границы

Отложенный исследовательский трек. Он не заменяет текущие rule-based стратегии и не
разрешает модели самостоятельно отправлять ордера. Первый полезный результат — несколько
LLM-кандидатов, которые получают один и тот же сохранённый рыночный контекст и работают
только в `shadow`-режиме.

Это направление отличается от самообучения из
[`11-SELF-LEARNING-MODELS.md`](11-SELF-LEARNING-MODELS.md): здесь внешняя модель принимает
решение по подготовленному контексту, но не обучается на сделках CryptoAnal и не изменяет
собственные веса.

## 1. Задачи торгового движка

Это общая основа CryptoAnal. Она не должна зависеть от конкретного LLM-провайдера.

### 1.1. Рыночный контекст

- [ ] Ввести immutable `DecisionContextSnapshot` с точным `availableAt`, content hash и
      provenance исходных свечей, котировок, аккаунта, стратегии и версии движка.
- [ ] Собирать один временно согласованный snapshot: OHLCV основного и старших таймфреймов,
      EMA/RSI/MACD, ATR, ADX, CHOP, RVOL, volatility, Z-score, slopes и pivot levels.
- [ ] Добавить в snapshot режим рынка, текущие позиции, доступный капитал, экспозицию,
      последние результаты стратегии и действующие risk limits.
- [ ] Не включать незакрытые свечи и сведения, которые не были доступны в момент решения;
      любое восстановление истории должно сохранять исходный `availableAt`.
- [ ] Версионировать feature set и одинаково считать его в runtime, replay и validation.

### 1.2. Универсальный контракт решения

- [ ] Выделить интерфейс `DecisionProvider`, независимый от rule-based, ML и LLM
      реализаций.
- [ ] Зафиксировать строгую схему результата: `BUY | SELL | HOLD`, сторона, tradability,
      confidence, размер или risk budget, SL, TP, горизонт и нормализованные reason codes.
- [ ] Разделить предложение модели и итоговое действие движка: сохранять исходный ответ,
      нормализованный candidate, решение risk engine и причину принятия или отклонения.
- [ ] Запретить provider самостоятельно создавать, изменять или закрывать exchange orders.

### 1.3. Частота и исполнение

- [ ] Добавить отдельный decision loop с настраиваемой частотой: по закрытию 1m/5m свечи
      либо не чаще заданного интервала.
- [ ] Оставить сопровождение открытой позиции, mark price, SL/TP, trailing stop и kill
      switch в быстром детерминированном quote loop без ожидания ответа модели.
- [ ] Добавить дедупликацию решения по `provider + deployment + context hash` и блокировку
      параллельного исполнения одного candidate.
- [ ] Определить политику просроченного ответа: решение после допустимого deadline
      сохраняется для анализа, но не исполняется.

### 1.4. Память решения

- [ ] Ввести bounded `DecisionMemory`: последние решения, текущая торговая гипотеза,
      состояние позиции и краткий итог завершённых сделок.
- [ ] Версионировать формат памяти и сохранять точный snapshot, переданный provider.
- [ ] Не позволять модели произвольно редактировать историю, лимиты или системные правила.
- [ ] Добавить явные reset/retention rules, чтобы память не росла бесконечно и не переносила
      контекст между workspace, strategy version или execution run.

### 1.5. Risk и safety

- [ ] Пропускать любой candidate через общий portfolio risk: capital reservation,
      aggregate exposure, max concurrent positions, daily loss и конфликт long/short.
- [ ] Ограничивать размер позиции и leverage на стороне движка, даже если provider вернул
      большее значение.
- [ ] Fail closed при stale/incomplete market data, недоступном provider, невалидной схеме,
      превышенном latency или отсутствии обязательной защиты позиции.
- [ ] Сохранить независимые global kill switch, exchange reconciliation и ручное закрытие.

### 1.6. Shadow, replay и оценка

- [ ] Реализовать `SHADOW` execution mode: решения и виртуальный результат сохраняются,
      но не влияют на текущие позиции и ордера.
- [ ] Раздавать один `DecisionContextSnapshot` нескольким providers/models без повторного
      чтения изменившегося рынка.
- [ ] Добавить deterministic replay сохранённых snapshots без повторного обращения к
      бирже; исходные ответы провайдера не перегенерировать при расчёте фактического
      результата.
- [ ] Считать coverage, schema/rejection rate, latency, turnover, fees, expectancy,
      drawdown, MAE/MFE и breakdown по парам, сторонам и режимам рынка.
- [ ] Сравнивать LLM-кандидатов с неизменённой rule-based стратегией на одинаковом периоде,
      risk budget и модели издержек.

## 2. Задачи LLM-интеграции

Этот слой подключает конкретные API к универсальному контракту движка.

### 2.1. Provider gateway

- [ ] Реализовать первый adapter через официальный API выбранного провайдера; не строить
      runtime на пользовательской подписке Codex/ChatGPT.
- [ ] Поддержать timeout, retry только безопасных запросов, rate limits, circuit breaker,
      request id и идемпотентность регистрации результата.
- [ ] Валидировать structured output по JSON Schema/Zod; текст вне схемы не превращать в
      торговое решение эвристиками.
- [ ] Хранить provider, model id, параметры inference, latency, usage и ориентировочную
      стоимость каждого запроса.
- [ ] Позже добавить второй облачный или локальный adapter без изменений execution engine.

### 2.2. Prompt registry

- [ ] Ввести immutable `PromptVersion`: system rules, шаблон контекста, schema version,
      changelog и hash.
- [ ] Отделить обязательные safety-инструкции от экспериментальной торговой гипотезы.
- [ ] Не передавать secrets, API keys, cookies, персональные данные пользователя и лишние
      внутренние поля workspace.
- [ ] Защитить prompt от текста из внешних источников: рыночные данные и календарные
      события передавать как данные, а не как инструкции.
- [ ] Добавить offline prompt replay на сохранённых snapshots до запуска shadow-провайдера.

### 2.3. Credentials и расходы

- [ ] Хранить provider credentials зашифрованно и workspace-scoped по модели exchange
      connections; никогда не возвращать secret в dashboard/API.
- [ ] Добавить дневной и месячный budget, лимит запросов, token ceiling и автоматическую
      остановку provider при превышении.
- [ ] Показывать стоимость на решение, сделку и эксперимент; отделять стоимость LLM от
      торговых fees и funding.
- [ ] Добавить owner-only rotation, revoke и audit trail для provider credentials.

### 2.4. Управление и наблюдаемость

- [ ] Добавить в Research/Experiments настройку provider, model, prompt version, cadence,
      symbols и shadow-only risk budget.
- [ ] Показывать timeline: snapshot → raw response → normalized candidate → risk verdict →
      hypothetical fill/outcome.
- [ ] Добавить health-метрики provider: доступность, latency percentiles, schema failures,
      stale decisions, rate-limit errors и расходы.
- [ ] Поддержать паузу конкретного provider/model без остановки market ingestion и
      детерминированного сопровождения существующих позиций.
- [ ] Добавить redacted export эксперимента для сравнения моделей без credentials и
      пользовательских данных.

## 3. Оптимальная последовательность

### Фаза A — engine foundation

1. `DecisionContextSnapshot` и versioned feature pipeline.
2. Универсальные `DecisionProvider` и `DecisionCandidate`.
3. Persistence, audit trail, bounded memory и decision cadence.
4. `SHADOW` mode, fan-out одного snapshot и deterministic replay.
5. Portfolio risk и safety gates должны быть готовы до любого исполняемого режима.

### Фаза B — первая интеграция

1. Один официальный API provider.
2. Один зафиксированный prompt и строгий structured output.
3. Credentials, budgets, timeout/rate-limit handling и observability.
4. Shadow-запуск параллельно с текущей rule-based стратегией.

### Фаза C — сравнительный эксперимент

1. Два-три model/prompt candidates получают одинаковые snapshots.
2. Конфигурации не меняются внутри контрольного периода.
3. Первый review — после достаточного покрытия разных режимов и минимум 500 сопоставимых
   решений; торговые выводы — не раньше 100 закрытых shadow/dry-run сделок на кандидата.
4. Отбирать кандидата по net expectancy, drawdown, costs, stability и rejection rate, а
   не по одному лучшему PnL.

### Фаза D — контролируемый dry-run

1. Выбранный challenger получает отдельный virtual account и неизменяемую версию.
2. Risk engine определяет фактический размер и может отклонить любое действие.
3. Exit protection остаётся детерминированной; модель сначала влияет только на вход или
   отказ от входа.
4. Переход к Bybit Demo возможен только после portfolio risk, demo reconciliation и
   отдельного operational review. `LIVE` в этот план не входит.

## 4. Что не смешивать

- Улучшение CHOP/ADX/ATR/RVOL, risk engine и replay — развитие движка, а не LLM-фича.
- Prompt, model selection, API credentials и token budgets — интеграционный слой.
- LLM decision provider — не самообучение. Training pipeline и `ModelVersion` остаются
  отдельным направлением из документа 11.
- Высокая частота LLM-запросов не заменяет realtime SL/TP и не является HFT.
- Публичный leaderboard или on-chain факт сделки не считается доказательством качества
  модели без одинаковых входных данных, risk budget и достаточной выборки.

