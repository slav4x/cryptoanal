import { reviewSessionCreateSchema } from "@cryptoanal/contracts";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
  Textarea,
} from "@cryptoanal/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createReviewSession } from "../../shared/api";

export function ReviewSessionComposer({
  currentDate,
  onClose,
}: {
  currentDate: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const today = currentDate.slice(0, 10);
  const weekAgo = new Date(new Date(today).getTime() - 6 * 86_400_000).toISOString().slice(0, 10);
  const [title, setTitle] = useState("");
  const [startsAt, setStartsAt] = useState(weekAgo);
  const [endsAt, setEndsAt] = useState(today);
  const [summary, setSummary] = useState("");
  const [learnings, setLearnings] = useState("");
  const [nextActions, setNextActions] = useState("");
  const [tags, setTags] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: createReviewSession,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["journal"] });
      onClose();
    },
  });

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Новый разбор периода</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="grid gap-3 xl:grid-cols-[1fr_190px_190px]">
          <Field label="Название">
            <Input
              value={title}
              maxLength={140}
              placeholder="Итоги торговой недели"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Начало">
            <Input
              type="date"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </Field>
          <Field label="Окончание">
            <Input type="date" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
          </Field>
        </div>
        <Field label="Итог">
          <Textarea
            value={summary}
            maxLength={10_000}
            placeholder="Что произошло и как это интерпретировать…"
            onChange={(event) => setSummary(event.target.value)}
          />
        </Field>
        <div className="grid gap-3 xl:grid-cols-2">
          <Field label="Выводы — по одному на строку">
            <Textarea
              value={learnings}
              placeholder="Что подтвердилось&#10;Что оказалось ошибкой"
              onChange={(event) => setLearnings(event.target.value)}
            />
          </Field>
          <Field label="Следующие действия — по одному на строку">
            <Textarea
              value={nextActions}
              placeholder="Что изменить&#10;Что проверить дальше"
              onChange={(event) => setNextActions(event.target.value)}
            />
          </Field>
        </div>
        <Field label="Теги через запятую">
          <Input
            value={tags}
            placeholder="weekly, risk-review"
            onChange={(event) => setTags(event.target.value)}
          />
        </Field>
        <p className="text-xs text-stale">
          В разбор войдут все записи журнала, время события которых попадает в выбранный период.
        </p>
        {formError || mutation.error ? (
          <p className="text-xs text-loss">{formError ?? mutation.error?.message}</p>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-row-border pt-4">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={mutation.isPending} onClick={() => submit()}>
            {mutation.isPending ? "Сохранение…" : "Зафиксировать разбор"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );

  function submit() {
    const result = reviewSessionCreateSchema.safeParse({
      title,
      startsAt: `${startsAt}T00:00:00.000Z`,
      endsAt: `${endsAt}T23:59:59.999Z`,
      summary,
      learnings: parseLines(learnings),
      nextActions: parseLines(nextActions),
      tags: parseList(tags),
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Проверьте поля разбора");
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

function parseLines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}
function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
