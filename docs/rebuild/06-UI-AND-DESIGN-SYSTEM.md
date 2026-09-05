# UI и дизайн-система CryptoAnal

## 1. Основа

Использовать shadcn/ui как набор контролируемых исходников компонентов, а не как готовую
тему. Внешний вид CryptoAnal определяется semantic CSS variables и вариантами компонентов.

Цели:

- широкое изменение темы через один слой tokens;
- отсутствие hardcoded цветов/радиусов в feature code;
- плотный профессиональный dashboard;
- единые состояния данных и действий;
- dark theme сначала, light theme — простой override позднее.

## 2. Структура UI package

```text
packages/ui/src/
  styles/
    tokens.css          # primitive + semantic variables
    theme-dark.css
    theme-light.css     # добавить, когда понадобится
    globals.css
  components/
    ui/                 # адаптированные shadcn primitives
    data-display/
    feedback/
    charts/
    trading/
  lib/
    cn.ts
    formatters.ts
```

Feature-level compositions остаются в `apps/dashboard`, универсальные primitives и
устоявшиеся domain widgets — в `packages/ui`.

## 3. Token model

### Базовые shadcn semantics

```css
:root {
  --background: ...;
  --foreground: ...;
  --card: ...;
  --card-foreground: ...;
  --popover: ...;
  --popover-foreground: ...;
  --primary: ...;
  --primary-foreground: ...;
  --secondary: ...;
  --secondary-foreground: ...;
  --muted: ...;
  --muted-foreground: ...;
  --accent: ...;
  --accent-foreground: ...;
  --destructive: ...;
  --destructive-foreground: ...;
  --border: ...;
  --input: ...;
  --ring: ...;
  --radius: ...;
}
```

### CryptoAnal semantics

```css
:root {
  --profit: ...;
  --profit-foreground: ...;
  --loss: ...;
  --loss-foreground: ...;
  --warning: ...;
  --info: ...;
  --neutral: ...;
  --live: ...;
  --paper: ...;
  --backtest: ...;
  --stale: ...;
  --chart-grid: ...;
  --chart-axis: ...;
  --chart-series-1: ...;
  --chart-series-2: ...;
  --sidebar-background: ...;
  --sidebar-foreground: ...;
  --sidebar-accent: ...;
  --sidebar-border: ...;
}
```

Также токенизировать:

- font families, sizes, line heights и numeric font;
- spacing и content widths;
- compact/default table density;
- chart heights;
- shadows/elevation;
- animation durations/easing;
- header/sidebar sizes;
- focus/error/disabled opacity.

Tailwind config связывает utilities с variables. В feature files запрещены hex/rgb и
прямые `slate-*`, `green-*`, `red-*`, если это не визуализация с утверждённой палитрой.

## 4. Компонентные уровни

### shadcn primitives

- Button, Input, Textarea, Select, Checkbox, RadioGroup, Switch;
- Card, Tabs, Accordion, Separator, Badge;
- Dialog, AlertDialog, Drawer, Sheet, Popover, Tooltip;
- DropdownMenu, Command, Breadcrumb;
- Table, Pagination, Skeleton, Toast;
- Form wrappers с единым label/help/error.

Варианты оформляются через CVA и semantic names: `profit`, `loss`, `warning`, `live`,
а не через цвет в названии.

### Product components

- `AppShell`, `PageHeader`, `FilterBar`, `DateRangePicker`;
- `MetricCard`, `MetricDelta`, `FreshnessBadge`, `EnvironmentBadge`;
- `MoneyValue`, `PercentValue`, `PriceValue`, `DurationValue`;
- `DataTable`, `EmptyState`, `ErrorState`, `StaleState`;
- `RuntimeStatus`, `RiskAlert`, `ConfirmTradingAction`;
- `StrategyStatus`, `VersionBadge`, `ValidationVerdict`;
- `PositionTable`, `TradeTable`, `DecisionTimeline`;
- `EquityChart`, `DrawdownChart`, `CandlestickChart`, `PnlCalendar`;
- `RunProgress`, `ConfigDiff`, `ProvenancePanel`.

## 5. Визуальное направление

Сохранить из текущего проекта:

- тёмную flat-основу;
- спокойный нейтральный chrome;
- зелёный/красный только для смысла profit/loss;
- высокую плотность таблиц;
- PnL calendar, charts и explainability timeline.

Изменить:

- уменьшить визуальный шум и число равнозначных карточек;
- построить ясную иерархию страницы;
- отделить рабочие данные от системной диагностики;
- унифицировать русские названия и оставить только устоявшиеся термины;
- показывать environment/freshness рядом с данными, а не в случайных местах.

## 6. Правила dashboard UX

- Один primary action на страницу/контекст.
- Фильтры сохраняются в URL и переживают refresh.
- Money/percent/time форматируются централизованно.
- Backtest, paper и live всегда визуально различимы текстом и цветом.
- Положительное число не всегда зелёное; цвет используется только при смысловой оценке.
- Любая метрика имеет tooltip с определением и, при необходимости, формулой.
- Empty state объясняет причину и предлагает допустимый следующий шаг.
- Error state даёт retry и request/correlation id.
- Stale data не маскируются обычным skeleton.
- После команды UI показывает accepted/pending/completed, а не оптимистичный успех.
- Dangerous actions используют `AlertDialog` с сущностью, режимом и последствиями.

## 7. Стратегия и формы

Strategy editor разбивается по предметным секциям, использует typed schema и показывает:

- field label и единицу;
- допустимый диапазон;
- effective/default value;
- validation errors рядом с полем;
- summary изменений перед созданием версии;
- diff относительно предыдущей версии;
- связь с validation status.

Не генерировать форму механически из огромного плоского JSON без продуктовой группировки.

## 8. Таблицы и данные

- desktop-first для рабочих таблиц, но без горизонтального хаоса;
- column visibility и density — общие настройки;
- server-side pagination/filtering для растущих коллекций;
- sticky header только когда помогает;
- row action не прячется исключительно в hover;
- значения выравниваются по разрядам;
- export повторяет активные filters;
- mobile показывает приоритетные колонки и details drawer.

## 9. Графики

- единая semantic palette и tooltip;
- явные timezone, interval и source;
- сравниваемые серии используют одинаковый scale либо предупреждение;
- axes не обрезают контекст ради красивого результата;
- live/backtest gaps не соединяются как непрерывная линия;
- canvas/chart modules lazy-loaded;
- таблица/summary доступна как текстовая альтернатива ключевым данным.

## 10. Responsive

- desktop: sidebar + широкий рабочий canvas;
- tablet: collapsible sidebar и адаптивные grids;
- mobile: drawer navigation, stacked summaries, отдельные details sheets;
- сложный editor на mobile поддерживает просмотр и базовые действия, но не обязан быть
  столь же плотным, как desktop;
- critical actions нельзя терять за hover или правым кликом.

## 11. Accessibility

- keyboard navigation для меню, tabs, dialogs и tables;
- видимый focus ring;
- color contrast не ниже WCAG AA для текста и controls;
- profit/loss/status различаются не только цветом;
- charts имеют accessible summary;
- reduced motion учитывается;
- touch targets не менее 44px на mobile, даже при compact desktop density.

## 12. Performance budget

- route-level code splitting;
- chart/editor загружаются только на нужных routes;
- dashboard shell не делает безусловный global polling;
- query interval зависит от freshness requirement;
- polling останавливается/замедляется на hidden tab;
- virtualize только реально большие lists;
- budget первого route JS фиксируется до реализации и контролируется сборкой.

## 13. Процесс изменения дизайна

1. Меняются primitive/semantic variables.
2. Проверяются shadcn variants и product components.
3. Feature pages не получают локальные цветовые «исправления».
4. Для крупного rebrand добавляется новая theme map, а не search/replace по проекту.
5. Любое исключение из tokens документируется в UI package.

Итоговое требование: смена accent, surface, radius, density и typography не должна
требовать ручного редактирования каждой страницы.
