import { strategyCreateSchema, type StrategyCreateDto } from "@cryptoanal/contracts";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  PageHeader,
  Textarea,
  cn,
} from "@cryptoanal/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, LoaderCircle } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiClientError, createStrategy } from "../../shared/api";

type ActiveDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

type FormState = {
  name: string;
  description: string;
  symbols: string;
  timeframe: string;
  direction: string;
  emaFastPeriod: string;
  emaSlowPeriod: string;
  rsiPeriod: string;
  rsiOversold: string;
  rsiOverbought: string;
  minimumVolume24hUsdt: string;
  minimumAtrPercent: string;
  maximumAtrPercent: string;
  riskPerTradePercent: string;
  maxOpenPositions: string;
  maxDailyLossPercent: string;
  orderType: string;
  limitOffsetBps: string;
  stopLossPercent: string;
  takeProfitPercent: string;
  trailingStopPercent: string;
  makerFeeBps: string;
  takerFeeBps: string;
  slippageBps: string;
  timezone: string;
  activeDays: ActiveDay[];
};

const initialForm: FormState = {
  name: "",
  description: "",
  symbols: "",
  timeframe: "15m",
  direction: "both",
  emaFastPeriod: "20",
  emaSlowPeriod: "50",
  rsiPeriod: "14",
  rsiOversold: "30",
  rsiOverbought: "70",
  minimumVolume24hUsdt: "10000000",
  minimumAtrPercent: "0.5",
  maximumAtrPercent: "8",
  riskPerTradePercent: "1",
  maxOpenPositions: "3",
  maxDailyLossPercent: "3",
  orderType: "market",
  limitOffsetBps: "0",
  stopLossPercent: "2",
  takeProfitPercent: "4",
  trailingStopPercent: "0",
  makerFeeBps: "2",
  takerFeeBps: "5.5",
  slippageBps: "3",
  timezone: "UTC",
  activeDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
};

export default function NewStrategyPage() {
  const [form, setForm] = useState<FormState>(initialForm);
  const [formError, setFormError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createMutation = useMutation({
    mutationFn: createStrategy,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
      navigate("/strategies");
    },
  });

  function updateField<Key extends keyof FormState>(key: Key, value: FormState[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setFormError(null);
    createMutation.reset();
  }

  function toggleDay(day: ActiveDay) {
    updateField(
      "activeDays",
      form.activeDays.includes(day)
        ? form.activeDays.filter((currentDay) => currentDay !== day)
        : [...form.activeDays, day],
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = strategyCreateSchema.safeParse(buildPayload(form));
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Проверьте параметры стратегии");
      return;
    }
    createMutation.mutate(result.data);
  }

  const requestError = createMutation.error;

  return (
    <form className="space-y-[18px]" onSubmit={handleSubmit} noValidate>
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" asChild className="mt-5 shrink-0">
          <Link to="/strategies" aria-label="Вернуться к стратегиям">
            <ArrowLeft aria-hidden="true" />
          </Link>
        </Button>
        <PageHeader
          eyebrow="Новая стратегия"
          title="Конфигурация v1"
          description="Сохранение создаст черновик и первую неизменяемую версию конфигурации. Запуск и валидация выполняются отдельно."
          actions={
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              Создать черновик
            </Button>
          }
        />
      </div>

      {(formError || requestError) && (
        <div className="rounded-[10px] border border-loss/30 bg-loss/5 px-4 py-3 text-sm text-loss">
          {formError ??
            (requestError instanceof ApiClientError
              ? requestError.message
              : "Не удалось создать стратегию")}
        </div>
      )}

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
            id="general"
            title="Основное"
            description="Название и назначение стратегии внутри workspace."
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Название" htmlFor="strategy-name" hint="От 3 до 80 символов">
                <Input
                  id="strategy-name"
                  value={form.name}
                  onChange={(event) => updateField("name", event.target.value)}
                  placeholder="Например, Trend following 15m"
                  autoComplete="off"
                  required
                  minLength={3}
                  maxLength={80}
                />
              </Field>
              <Field
                label="Описание"
                htmlFor="strategy-description"
                hint="Необязательно, до 500 символов"
              >
                <Textarea
                  id="strategy-description"
                  value={form.description}
                  onChange={(event) => updateField("description", event.target.value)}
                  placeholder="Коротко опишите идею и условия применения"
                  maxLength={500}
                  className="min-h-20"
                />
              </Field>
            </div>
          </FormSection>

          <FormSection
            id="universe"
            title="Universe"
            description="Инструменты и базовый таймфрейм, на которых рассчитываются сигналы."
          >
            <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(180px,1fr)]">
              <Field
                label="Торговые пары"
                htmlFor="strategy-symbols"
                hint="Через запятую или пробел, например BTCUSDT, ETHUSDT"
              >
                <Input
                  id="strategy-symbols"
                  value={form.symbols}
                  onChange={(event) => updateField("symbols", event.target.value.toUpperCase())}
                  placeholder="BTCUSDT, ETHUSDT"
                  autoCapitalize="characters"
                  required
                />
              </Field>
              <SelectField
                id="strategy-timeframe"
                label="Таймфрейм"
                value={form.timeframe}
                onChange={(value) => updateField("timeframe", value)}
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
                id="strategy-direction"
                label="Направление"
                value={form.direction}
                onChange={(value) => updateField("direction", value)}
                options={directionOptions}
              />
              <NumberField
                id="ema-fast"
                label="Быстрая EMA"
                value={form.emaFastPeriod}
                onChange={(value) => updateField("emaFastPeriod", value)}
                min="2"
                max="200"
                step="1"
              />
              <NumberField
                id="ema-slow"
                label="Медленная EMA"
                value={form.emaSlowPeriod}
                onChange={(value) => updateField("emaSlowPeriod", value)}
                min="3"
                max="400"
                step="1"
              />
              <NumberField
                id="rsi-period"
                label="Период RSI"
                value={form.rsiPeriod}
                onChange={(value) => updateField("rsiPeriod", value)}
                min="2"
                max="100"
                step="1"
              />
              <NumberField
                id="rsi-oversold"
                label="RSI oversold"
                value={form.rsiOversold}
                onChange={(value) => updateField("rsiOversold", value)}
                min="1"
                max="49"
              />
              <NumberField
                id="rsi-overbought"
                label="RSI overbought"
                value={form.rsiOverbought}
                onChange={(value) => updateField("rsiOverbought", value)}
                min="51"
                max="99"
              />
            </div>
          </FormSection>

          <FormSection
            id="filters"
            title="Filters"
            description="Ограничения ликвидности и волатильности до формирования сигнала."
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                id="minimum-volume"
                label="Мин. объём за 24 часа"
                suffix="USDT"
                value={form.minimumVolume24hUsdt}
                onChange={(value) => updateField("minimumVolume24hUsdt", value)}
                min="0"
                step="100000"
              />
              <NumberField
                id="minimum-atr"
                label="Мин. ATR"
                suffix="%"
                value={form.minimumAtrPercent}
                onChange={(value) => updateField("minimumAtrPercent", value)}
                min="0"
                max="100"
                step="0.1"
              />
              <NumberField
                id="maximum-atr"
                label="Макс. ATR"
                suffix="%"
                value={form.maximumAtrPercent}
                onChange={(value) => updateField("maximumAtrPercent", value)}
                min="0"
                max="100"
                step="0.1"
              />
            </div>
          </FormSection>

          <FormSection id="risk" title="Risk" description="Лимиты одной сделки и всей стратегии.">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                id="risk-per-trade"
                label="Риск на сделку"
                suffix="%"
                value={form.riskPerTradePercent}
                onChange={(value) => updateField("riskPerTradePercent", value)}
                min="0.01"
                max="10"
                step="0.01"
              />
              <NumberField
                id="max-open-positions"
                label="Открытых позиций"
                value={form.maxOpenPositions}
                onChange={(value) => updateField("maxOpenPositions", value)}
                min="1"
                max="20"
                step="1"
              />
              <NumberField
                id="max-daily-loss"
                label="Дневной лимит убытка"
                suffix="%"
                value={form.maxDailyLossPercent}
                onChange={(value) => updateField("maxDailyLossPercent", value)}
                min="0.01"
                max="50"
                step="0.01"
              />
            </div>
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
                value={form.orderType}
                onChange={(value) => updateField("orderType", value)}
                options={orderTypeOptions}
              />
              <NumberField
                id="limit-offset"
                label="Смещение лимитной цены"
                suffix="bps"
                value={form.limitOffsetBps}
                onChange={(value) => updateField("limitOffsetBps", value)}
                min="0"
                max="500"
                step="0.1"
                disabled={form.orderType === "market"}
              />
            </div>
          </FormSection>

          <FormSection
            id="exit"
            title="Exit"
            description="Защитный стоп, фиксация прибыли и сопровождение позиции."
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                id="stop-loss"
                label="Stop loss"
                suffix="%"
                value={form.stopLossPercent}
                onChange={(value) => updateField("stopLossPercent", value)}
                min="0.01"
                max="100"
                step="0.01"
              />
              <NumberField
                id="take-profit"
                label="Take profit"
                suffix="%"
                value={form.takeProfitPercent}
                onChange={(value) => updateField("takeProfitPercent", value)}
                min="0.01"
                max="500"
                step="0.01"
              />
              <NumberField
                id="trailing-stop"
                label="Trailing stop"
                suffix="%"
                value={form.trailingStopPercent}
                onChange={(value) => updateField("trailingStopPercent", value)}
                min="0"
                max="100"
                step="0.01"
              />
            </div>
          </FormSection>

          <FormSection
            id="costs"
            title="Costs"
            description="Комиссии и проскальзывание для расчётов и будущей валидации."
          >
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <NumberField
                id="maker-fee"
                label="Maker fee"
                suffix="bps"
                value={form.makerFeeBps}
                onChange={(value) => updateField("makerFeeBps", value)}
                min="0"
                max="100"
                step="0.1"
              />
              <NumberField
                id="taker-fee"
                label="Taker fee"
                suffix="bps"
                value={form.takerFeeBps}
                onChange={(value) => updateField("takerFeeBps", value)}
                min="0"
                max="100"
                step="0.1"
              />
              <NumberField
                id="slippage"
                label="Проскальзывание"
                suffix="bps"
                value={form.slippageBps}
                onChange={(value) => updateField("slippageBps", value)}
                min="0"
                max="500"
                step="0.1"
              />
            </div>
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
                  value={form.timezone}
                  onChange={(event) => updateField("timezone", event.target.value)}
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
                    const selected = form.activeDays.includes(day.value);
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

          <div className="flex items-center justify-end gap-3 pb-[18px]">
            <Button type="button" variant="ghost" asChild>
              <Link to="/strategies">Отмена</Link>
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              Создать черновик
            </Button>
          </div>
        </div>
      </div>
    </form>
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
        <label htmlFor={htmlFor} className="text-xs font-medium text-secondary-foreground">
          {label}
        </label>
        {hint ? <span className="text-[10px] text-stale">{hint}</span> : null}
      </div>
      {children}
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
} & Pick<React.ComponentProps<"input">, "min" | "max" | "step" | "disabled">) {
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
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-full rounded-[10px] border border-input bg-background px-3 text-sm text-foreground outline-none transition-shadow focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function buildPayload(form: FormState): StrategyCreateDto {
  const symbols = Array.from(
    new Set(
      form.symbols
        .split(/[\s,]+/)
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  );

  return {
    name: form.name,
    description: form.description.trim() || null,
    config: {
      schemaVersion: 1,
      universe: {
        symbols,
        timeframe: form.timeframe as StrategyCreateDto["config"]["universe"]["timeframe"],
      },
      signal: {
        direction: form.direction as StrategyCreateDto["config"]["signal"]["direction"],
        emaFastPeriod: Number(form.emaFastPeriod),
        emaSlowPeriod: Number(form.emaSlowPeriod),
        rsiPeriod: Number(form.rsiPeriod),
        rsiOversold: Number(form.rsiOversold),
        rsiOverbought: Number(form.rsiOverbought),
      },
      filters: {
        minimumVolume24hUsdt: Number(form.minimumVolume24hUsdt),
        minimumAtrPercent: Number(form.minimumAtrPercent),
        maximumAtrPercent: Number(form.maximumAtrPercent),
      },
      risk: {
        riskPerTradePercent: Number(form.riskPerTradePercent),
        maxOpenPositions: Number(form.maxOpenPositions),
        maxDailyLossPercent: Number(form.maxDailyLossPercent),
      },
      entry: {
        orderType: form.orderType as StrategyCreateDto["config"]["entry"]["orderType"],
        limitOffsetBps: Number(form.limitOffsetBps),
      },
      exit: {
        stopLossPercent: Number(form.stopLossPercent),
        takeProfitPercent: Number(form.takeProfitPercent),
        trailingStopPercent: Number(form.trailingStopPercent),
      },
      costs: {
        makerFeeBps: Number(form.makerFeeBps),
        takerFeeBps: Number(form.takerFeeBps),
        slippageBps: Number(form.slippageBps),
      },
      schedule: {
        timezone: form.timezone,
        activeDays: form.activeDays,
      },
    },
  };
}

const sections = [
  { id: "general", label: "Основное" },
  { id: "universe", label: "Universe" },
  { id: "signal", label: "Signal" },
  { id: "filters", label: "Filters" },
  { id: "risk", label: "Risk" },
  { id: "entry", label: "Entry" },
  { id: "exit", label: "Exit" },
  { id: "costs", label: "Costs" },
  { id: "schedule", label: "Schedule" },
] as const;

const timeframeOptions = [
  { value: "5m", label: "5 минут" },
  { value: "15m", label: "15 минут" },
  { value: "30m", label: "30 минут" },
  { value: "1h", label: "1 час" },
  { value: "4h", label: "4 часа" },
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
