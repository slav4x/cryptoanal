import {
  playbookCreateSchema,
  playbookUpdateSchema,
  type PlaybookDto,
  type PlaybooksDto,
} from "@cryptoanal/contracts";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
  cn,
} from "@cryptoanal/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createPlaybook, updatePlaybook } from "../../shared/api";

export function PlaybookComposer({
  playbook,
  options,
  onClose,
  onSaved,
}: {
  playbook: PlaybookDto | null;
  options: PlaybooksDto["linkOptions"];
  onClose: () => void;
  onSaved: (playbookId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(playbook?.name ?? "");
  const [description, setDescription] = useState(playbook?.description ?? "");
  const [marketConditions, setMarketConditions] = useState(playbook?.marketConditions ?? "");
  const [entryRules, setEntryRules] = useState(toText(playbook?.entryRules));
  const [exitRules, setExitRules] = useState(toText(playbook?.exitRules));
  const [riskRules, setRiskRules] = useState(toText(playbook?.riskRules));
  const [invalidationRules, setInvalidationRules] = useState(toText(playbook?.invalidationRules));
  const [checklist, setChecklist] = useState(toText(playbook?.checklist));
  const [tags, setTags] = useState(playbook?.tags.join(", ") ?? "");
  const [strategyIds, setStrategyIds] = useState(playbook?.strategies.map((item) => item.id) ?? []);
  const [tradeIds, setTradeIds] = useState(playbook?.exampleTrades.map((item) => item.id) ?? []);
  const [formError, setFormError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: ReturnType<typeof buildInput>) =>
      playbook
        ? updatePlaybook(playbook.id, { ...input, expectedUpdatedAt: playbook.updatedAt })
        : createPlaybook(input),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ["playbooks"] });
      onSaved(response.data.playbook.id);
    },
  });

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{playbook ? "Редактирование плейбука" : "Новый плейбук"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 pt-4">
        <div className="grid gap-3 xl:grid-cols-[minmax(260px,0.7fr)_1.3fr]">
          <Field label="Название">
            <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Короткое описание">
            <Input
              value={description}
              maxLength={2_000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>

        <Field label="Условия рынка">
          <Textarea
            value={marketConditions}
            maxLength={4_000}
            placeholder="Когда этот сетап имеет смысл применять"
            onChange={(event) => setMarketConditions(event.target.value)}
          />
        </Field>

        <div className="grid gap-3 xl:grid-cols-2">
          <RulesField
            label="Правила входа"
            value={entryRules}
            placeholder="Одно правило на строку"
            onChange={setEntryRules}
          />
          <RulesField
            label="Условия инвалидации"
            value={invalidationRules}
            placeholder="Когда сетап больше нельзя применять"
            onChange={setInvalidationRules}
          />
          <RulesField label="Правила выхода" value={exitRules} onChange={setExitRules} />
          <RulesField label="Риск-правила" value={riskRules} onChange={setRiskRules} />
        </div>

        <RulesField
          label="Чек-лист перед входом"
          value={checklist}
          placeholder="Каждый пункт с новой строки"
          onChange={setChecklist}
        />

        <div className="grid gap-3 xl:grid-cols-2">
          <Field label="Стратегии">
            <OptionGrid
              options={options.strategies}
              selected={strategyIds}
              empty="Нет доступных стратегий"
              onToggle={(id) => setStrategyIds(toggle(strategyIds, id))}
            />
          </Field>
          <Field label="Примеры сделок">
            <OptionGrid
              options={options.trades}
              selected={tradeIds}
              empty="Закрытых сделок пока нет"
              onToggle={(id) => setTradeIds(toggle(tradeIds, id))}
            />
          </Field>
        </div>

        <Field label="Теги через запятую">
          <Input
            value={tags}
            placeholder="breakout, momentum, btc"
            onChange={(event) => setTags(event.target.value)}
          />
        </Field>

        {formError || mutation.error ? (
          <p className="text-xs text-loss">{formError ?? mutation.error?.message}</p>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-row-border pt-4">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending} onClick={submit}>
            {mutation.isPending ? "Сохранение…" : playbook ? "Сохранить изменения" : "Создать"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  function buildInput() {
    return {
      name,
      description,
      marketConditions,
      entryRules: parseLines(entryRules),
      exitRules: parseLines(exitRules),
      riskRules: parseLines(riskRules),
      invalidationRules: parseLines(invalidationRules),
      checklist: parseLines(checklist),
      tags: tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      strategyIds,
      tradeIds,
    };
  }

  function submit() {
    const input = buildInput();
    const result = playbook
      ? playbookUpdateSchema.safeParse({ ...input, expectedUpdatedAt: playbook.updatedAt })
      : playbookCreateSchema.safeParse(input);
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Проверьте поля плейбука");
      return;
    }
    setFormError(null);
    mutation.mutate(input);
  }
}

function RulesField({
  label,
  value,
  placeholder = "Одно правило на строку",
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Textarea
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function OptionGrid({
  options,
  selected,
  empty,
  onToggle,
}: {
  options: Array<{ id: string; label: string }>;
  selected: string[];
  empty: string;
  onToggle: (id: string) => void;
}) {
  if (options.length === 0) {
    return (
      <div className="rounded-[9px] border border-dashed border-input p-3 text-xs text-stale">
        {empty}
      </div>
    );
  }
  return (
    <div className="max-h-36 space-y-1 overflow-y-auto rounded-[9px] border border-input bg-background p-1.5">
      {options.map((option) => {
        const active = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            className={cn(
              "block w-full rounded-[7px] px-2.5 py-2 text-left text-xs transition-colors",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60",
            )}
            onClick={() => onToggle(option.id)}
          >
            <span className="mr-2 font-mono text-[10px]">{active ? "[×]" : "[ ]"}</span>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1.5">
      <span className="block text-[10px] uppercase tracking-[0.1em] text-stale">{label}</span>
      {children}
    </label>
  );
}

function parseLines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toText(lines?: string[]) {
  return lines?.join("\n") ?? "";
}

function toggle(items: string[], item: string) {
  return items.includes(item) ? items.filter((current) => current !== item) : [...items, item];
}
