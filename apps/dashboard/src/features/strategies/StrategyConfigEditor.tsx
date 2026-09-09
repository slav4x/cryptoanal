import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@cryptoanal/ui";
import type { ComponentProps, ReactNode } from "react";
import type { ActiveDay, StrategyConfigDraft } from "./strategy-config-form";

type Props = {
  value: StrategyConfigDraft;
  onChange: (value: StrategyConfigDraft) => void;
};

export function StrategyConfigEditor({ value, onChange }: Props) {
  function update<Key extends keyof StrategyConfigDraft>(
    key: Key,
    fieldValue: StrategyConfigDraft[Key],
  ) {
    onChange({ ...value, [key]: fieldValue });
  }

  function toggleDay(day: ActiveDay) {
    update(
      "activeDays",
      value.activeDays.includes(day)
        ? value.activeDays.filter((currentDay) => currentDay !== day)
        : [...value.activeDays, day],
    );
  }

  return (
    <div className="grid items-start gap-[18px] xl:grid-cols-[190px_minmax(0,1fr)]">
      <nav className="sticky top-[18px] hidden rounded-[14px] border bg-card p-2 xl:block">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="block rounded-[9px] px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <div className="min-w-0 space-y-[18px]">
        <FormSection
          id="universe"
          title="Universe"
          description="Инструменты и базовый таймфрейм, на которых рассчитываются сигналы."
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(180px,1fr)]">
            <Field label="Торговые пары" htmlFor="strategy-symbols" hint="Через запятую или пробел">
              <Input
                id="strategy-symbols"
                value={value.symbols}
                onChange={(event) => update("symbols", event.target.value.toUpperCase())}
                placeholder="BTCUSDT, ETHUSDT"
                autoCapitalize="characters"
                required
              />
            </Field>
            <SelectField
              id="strategy-timeframe"
              label="Таймфрейм"
              value={value.timeframe}
              onChange={(fieldValue) => update("timeframe", fieldValue)}
              options={timeframeOptions}
            />
          </div>
        </FormSection>

        <FormSection
          id="signal"
          title="Signal"
          description="Параметры направления, тренда и момента входа."
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <SelectField
              id="strategy-signal-family"
              label="Семейство сигналов"
              value={value.signalFamily}
              onChange={(fieldValue) => update("signalFamily", fieldValue)}
              options={signalFamilyOptions}
            />
            <SelectField
              id="strategy-direction"
              label="Направление"
              value={value.direction}
              onChange={(fieldValue) => update("direction", fieldValue)}
              options={directionOptions}
            />
            {signalFieldsFor(value.signalFamily).map(({ key, ...field }) => (
              <NumberField
                key={key}
                {...field}
                value={value[key]}
                onChange={(fieldValue) => update(key, fieldValue)}
              />
            ))}
          </div>
        </FormSection>

        <FormSection
          id="filters"
          title="Filters"
          description="Ограничения ликвидности и волатильности до формирования сигнала."
        >
          <NumberGrid fields={filterFields} value={value} update={update} />
        </FormSection>

        <FormSection id="risk" title="Risk" description="Лимиты одной сделки и всей стратегии.">
          <NumberGrid fields={riskFields} value={value} update={update} />
        </FormSection>

        <FormSection
          id="entry"
          title="Entry"
          description="Тип заявки и допустимое смещение цены входа."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <SelectField
              id="order-type"
              label="Тип заявки"
              value={value.orderType}
              onChange={(fieldValue) => update("orderType", fieldValue)}
              options={orderTypeOptions}
            />
            <NumberField
              id="limit-offset"
              label="Смещение лимитной цены"
              suffix="bps"
              value={value.limitOffsetBps}
              onChange={(fieldValue) => update("limitOffsetBps", fieldValue)}
              min="0"
              max="500"
              step="0.1"
              disabled={value.orderType === "market"}
            />
          </div>
        </FormSection>

        <FormSection
          id="exit"
          title="Exit"
          description="Защитный стоп, фиксация прибыли и сопровождение позиции."
        >
          <NumberGrid fields={exitFields} value={value} update={update} />
        </FormSection>

        <FormSection
          id="costs"
          title="Costs"
          description="Комиссии и проскальзывание для расчётов и будущей валидации."
        >
          <NumberGrid fields={costFields} value={value} update={update} />
        </FormSection>

        <FormSection
          id="schedule"
          title="Schedule"
          description="Часовой пояс и дни, когда стратегия может формировать новые входы."
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(180px,1fr)_minmax(0,2fr)]">
            <Field label="Часовой пояс" htmlFor="strategy-timezone">
              <Input
                id="strategy-timezone"
                value={value.timezone}
                onChange={(event) => update("timezone", event.target.value)}
                placeholder="UTC"
                required
              />
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-secondary-foreground">
                Активные дни
              </legend>
              <div className="flex flex-wrap gap-2">
                {dayOptions.map((day) => {
                  const selected = value.activeDays.includes(day.value);
                  return (
                    <Button
                      key={day.value}
                      type="button"
                      size="sm"
                      variant={selected ? "secondary" : "outline"}
                      className={cn(selected && "border border-input text-foreground")}
                      aria-pressed={selected}
                      onClick={() => toggleDay(day.value)}
                    >
                      {day.label}
                    </Button>
                  );
                })}
              </div>
            </fieldset>
          </div>
        </FormSection>
      </div>
    </div>
  );
}

function FormSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-[18px]">
      <CardHeader className="border-b px-[18px] py-4">
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-[18px]">{children}</CardContent>
    </Card>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor}>
          <FieldLabel>{label}</FieldLabel>
        </label>
        {hint ? <span className="text-[10px] text-stale">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

type NumericKey = {
  [Key in keyof StrategyConfigDraft]: StrategyConfigDraft[Key] extends string ? Key : never;
}[keyof StrategyConfigDraft];

type NumberFieldDefinition = {
  key: NumericKey;
  id: string;
  label: string;
  suffix?: string;
  min?: string;
  max?: string;
  step?: string;
};

function NumberGrid({
  fields,
  value,
  update,
}: {
  fields: ReadonlyArray<NumberFieldDefinition>;
  value: StrategyConfigDraft;
  update: <Key extends keyof StrategyConfigDraft>(
    key: Key,
    fieldValue: StrategyConfigDraft[Key],
  ) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {fields.map(({ key, ...field }) => (
        <NumberField
          key={key}
          {...field}
          value={value[key]}
          onChange={(fieldValue) => update(key, fieldValue)}
        />
      ))}
    </div>
  );
}

function NumberField({
  id,
  label,
  suffix,
  value,
  onChange,
  ...inputProps
}: {
  id: string;
  label: string;
  suffix?: string;
  value: string;
  onChange: (value: string) => void;
} & Pick<ComponentProps<"input">, "min" | "max" | "step" | "disabled">) {
  return (
    <Field label={label} htmlFor={id}>
      <div className="relative">
        <Input
          id={id}
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={suffix ? "pr-14 font-mono tabular-nums" : "font-mono tabular-nums"}
          required
          {...inputProps}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-stale">
            {suffix}
          </span>
        ) : null}
      </div>
    </Field>
  );
}

function SelectField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

const sections = [
  { id: "universe", label: "Universe" },
  { id: "signal", label: "Signal" },
  { id: "filters", label: "Filters" },
  { id: "risk", label: "Risk" },
  { id: "entry", label: "Entry" },
  { id: "exit", label: "Exit" },
  { id: "costs", label: "Costs" },
  { id: "schedule", label: "Schedule" },
] as const;

const emaSignalFields = [
  { key: "emaFastPeriod", id: "ema-fast", label: "Быстрая EMA", min: "2", max: "200" },
  { key: "emaSlowPeriod", id: "ema-slow", label: "Медленная EMA", min: "3", max: "400" },
  { key: "rsiPeriod", id: "rsi-period", label: "Период RSI", min: "2", max: "100" },
  { key: "rsiOversold", id: "rsi-oversold", label: "RSI oversold", min: "1", max: "49" },
  { key: "rsiOverbought", id: "rsi-overbought", label: "RSI overbought", min: "51", max: "99" },
] as const satisfies ReadonlyArray<NumberFieldDefinition>;

const breakoutSignalFields = [
  {
    key: "breakoutLookbackPeriod",
    id: "breakout-lookback",
    label: "Период диапазона",
    min: "2",
    max: "400",
  },
] as const satisfies ReadonlyArray<NumberFieldDefinition>;

const meanReversionSignalFields = [
  {
    key: "meanReversionLookbackPeriod",
    id: "mean-reversion-lookback",
    label: "Период средней",
    min: "5",
    max: "400",
  },
  {
    key: "meanReversionEntryZScore",
    id: "mean-reversion-entry-z-score",
    label: "Порог отклонения",
    suffix: "σ",
    min: "0.5",
    max: "5",
    step: "0.1",
  },
  { key: "rsiPeriod", id: "rsi-period", label: "Период RSI", min: "2", max: "100" },
  { key: "rsiOversold", id: "rsi-oversold", label: "RSI oversold", min: "1", max: "49" },
  { key: "rsiOverbought", id: "rsi-overbought", label: "RSI overbought", min: "51", max: "99" },
] as const satisfies ReadonlyArray<NumberFieldDefinition>;

const momentumSignalFields = [
  {
    key: "momentumLookbackPeriod",
    id: "momentum-lookback",
    label: "Период импульса",
    min: "2",
    max: "400",
  },
  {
    key: "momentumThresholdPercent",
    id: "momentum-threshold",
    label: "Порог импульса",
    suffix: "%",
    min: "0.01",
    max: "100",
    step: "0.1",
  },
] as const satisfies ReadonlyArray<NumberFieldDefinition>;

function signalFieldsFor(family: string): ReadonlyArray<NumberFieldDefinition> {
  if (family === "breakout") return breakoutSignalFields;
  if (family === "mean-reversion") return meanReversionSignalFields;
  if (family === "momentum") return momentumSignalFields;
  return emaSignalFields;
}

const filterFields = [
  {
    key: "minimumVolume24hUsdt",
    id: "minimum-volume",
    label: "Мин. объём за 24 часа",
    suffix: "USDT",
    min: "0",
    step: "100000",
  },
  {
    key: "minimumAtrPercent",
    id: "minimum-atr",
    label: "Мин. ATR",
    suffix: "%",
    min: "0",
    max: "100",
    step: "0.1",
  },
  {
    key: "maximumAtrPercent",
    id: "maximum-atr",
    label: "Макс. ATR",
    suffix: "%",
    min: "0",
    max: "100",
    step: "0.1",
  },
] as const satisfies ReadonlyArray<NumberFieldDefinition>;

const riskFields = [
  {
    key: "riskPerTradePercent",
    id: "risk-per-trade",
    label: "Риск на сделку",
    suffix: "%",
    min: "0.01",
    max: "10",
    step: "0.01",
  },
  {
    key: "maxOpenPositions",
    id: "max-open-positions",
    label: "Открытых позиций",
    min: "1",
    max: "20",
    step: "1",
  },
  {
    key: "maxDailyLossPercent",
    id: "max-daily-loss",
    label: "Дневной лимит убытка",
    suffix: "%",
    min: "0.01",
    max: "50",
    step: "0.01",
  },
] as const satisfies ReadonlyArray<NumberFieldDefinition>;

const exitFields = [
  {
    key: "stopLossPercent",
    id: "stop-loss",
    label: "Stop loss",
    suffix: "%",
    min: "0.01",
    max: "100",
    step: "0.01",
  },
  {
    key: "takeProfitPercent",
    id: "take-profit",
    label: "Take profit",
    suffix: "%",
    min: "0.01",
    max: "500",
    step: "0.01",
  },
  {
    key: "trailingStopPercent",
    id: "trailing-stop",
    label: "Trailing stop",
    suffix: "%",
    min: "0",
    max: "100",
    step: "0.01",
  },
] as const satisfies ReadonlyArray<NumberFieldDefinition>;

const costFields = [
  {
    key: "makerFeeBps",
    id: "maker-fee",
    label: "Maker fee",
    suffix: "bps",
    min: "0",
    max: "100",
    step: "0.1",
  },
  {
    key: "takerFeeBps",
    id: "taker-fee",
    label: "Taker fee",
    suffix: "bps",
    min: "0",
    max: "100",
    step: "0.1",
  },
  {
    key: "slippageBps",
    id: "slippage",
    label: "Проскальзывание",
    suffix: "bps",
    min: "0",
    max: "500",
    step: "0.1",
  },
] as const satisfies ReadonlyArray<NumberFieldDefinition>;

const timeframeOptions = [
  { value: "5m", label: "5 минут" },
  { value: "15m", label: "15 минут" },
  { value: "30m", label: "30 минут" },
  { value: "1h", label: "1 час" },
  { value: "4h", label: "4 часа" },
] as const;

const signalFamilyOptions = [
  { value: "ema-crossover", label: "EMA crossover" },
  { value: "breakout", label: "Пробой диапазона" },
  { value: "mean-reversion", label: "Возврат к средней" },
  { value: "momentum", label: "Momentum" },
] as const;

const directionOptions = [
  { value: "both", label: "Long и short" },
  { value: "long", label: "Только long" },
  { value: "short", label: "Только short" },
] as const;

const orderTypeOptions = [
  { value: "market", label: "Market" },
  { value: "limit", label: "Limit" },
] as const;

const dayOptions: Array<{ value: ActiveDay; label: string }> = [
  { value: "mon", label: "Пн" },
  { value: "tue", label: "Вт" },
  { value: "wed", label: "Ср" },
  { value: "thu", label: "Чт" },
  { value: "fri", label: "Пт" },
  { value: "sat", label: "Сб" },
  { value: "sun", label: "Вс" },
];
