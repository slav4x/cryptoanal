import {
  journalEntryCreateSchema,
  type JournalDto,
  type JournalEntryKind,
  type JournalLinkType,
} from "@cryptoanal/contracts";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
  Select,
  Textarea,
} from "@cryptoanal/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createJournalEntry } from "../../shared/api";

type InitialLink = { type: JournalLinkType; targetId: string } | null;

export function JournalEntryComposer({
  options,
  initialLink,
  onClose,
}: {
  options: JournalDto["linkOptions"];
  initialLink: InitialLink;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<JournalEntryKind>("observation");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [occurredAt, setOccurredAt] = useState(toLocalDateTime(new Date()));
  const [linkType, setLinkType] = useState<JournalLinkType | "">(initialLink?.type ?? "");
  const [targetId, setTargetId] = useState(initialLink?.targetId ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const targetOptions = useMemo(() => getTargetOptions(options, linkType), [options, linkType]);
  const mutation = useMutation({
    mutationFn: createJournalEntry,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journal"] });
      onClose();
    },
  });

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Новая запись</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="grid gap-3 xl:grid-cols-[180px_1fr_220px]">
          <Field label="Тип">
            <Select
              value={kind}
              onChange={(event) => setKind(event.target.value as JournalEntryKind)}
            >
              {Object.entries(kindLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Заголовок">
            <Input
              value={title}
              maxLength={140}
              placeholder="Что проверяем или фиксируем"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Время события">
            <Input
              type="datetime-local"
              value={occurredAt}
              onChange={(event) => setOccurredAt(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Содержание">
          <Textarea
            value={body}
            maxLength={10_000}
            placeholder="Наблюдение, аргументы, вывод или решение…"
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>
        <div className="grid gap-3 xl:grid-cols-[1fr_210px_1fr]">
          <Field label="Теги через запятую">
            <Input
              value={tags}
              placeholder="risk, btc, entry"
              onChange={(event) => setTags(event.target.value)}
            />
          </Field>
          <Field label="Тип связи">
            <Select
              value={linkType}
              onChange={(event) => {
                setLinkType(event.target.value as JournalLinkType | "");
                setTargetId("");
              }}
            >
              <option value="">Без связи</option>
              {Object.entries(linkTypeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Связанный объект">
            <Select
              value={targetId}
              disabled={!linkType}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">Не выбран</option>
              {targetOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {formError || mutation.error ? (
          <p className="text-xs text-loss">{formError ?? mutation.error?.message}</p>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-row-border pt-4">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending} onClick={() => submit()}>
            {mutation.isPending ? "Сохранение…" : "Сохранить запись"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  function submit() {
    const result = journalEntryCreateSchema.safeParse({
      kind,
      title,
      body,
      tags: parseList(tags),
      occurredAt: new Date(occurredAt).toISOString(),
      links: linkType && targetId ? [{ type: linkType, targetId }] : [],
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Проверьте поля записи");
      return;
    }
    setFormError(null);
    mutation.mutate(result.data);
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1.5">
      <FieldLabel>{label}</FieldLabel>
      {children}
    </label>
  );
}

function getTargetOptions(options: JournalDto["linkOptions"], type: JournalLinkType | "") {
  if (type === "strategy") return options.strategies;
  if (type === "strategy-version") return options.strategyVersions;
  if (type === "execution-run") return options.executionRuns;
  if (type === "validation-run") return options.validationRuns;
  if (type === "trade") return options.trades;
  if (type === "decision") return options.decisions;
  if (type === "symbol") return options.symbols;
  return [];
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toLocalDateTime(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

const kindLabels: Record<JournalEntryKind, string> = {
  hypothesis: "Гипотеза",
  observation: "Наблюдение",
  conclusion: "Вывод",
  decision: "Решение",
};

const linkTypeLabels: Record<JournalLinkType, string> = {
  strategy: "Стратегия",
  "strategy-version": "Версия стратегии",
  "execution-run": "Execution run",
  "validation-run": "Validation run",
  trade: "Сделка",
  decision: "Решение runtime",
  symbol: "Пара",
};
