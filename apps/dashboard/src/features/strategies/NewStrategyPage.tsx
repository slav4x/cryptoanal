import { strategyCreateSchema } from "@cryptoanal/contracts";
import { Button, Card, CardContent, Input, PageHeader, Textarea } from "@cryptoanal/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, LoaderCircle } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiClientError, createStrategy } from "../../shared/api";
import { defaultStrategyConfigDraft, draftToStrategyConfig } from "./strategy-config-form";
import { StrategyConfigEditor } from "./StrategyConfigEditor";

export default function NewStrategyPage() {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [config, setConfig] = useState({ ...defaultStrategyConfigDraft });
  const [formError, setFormError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createMutation = useMutation({
    mutationFn: createStrategy,
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
      navigate(`/strategies/${response.data.id}`);
    },
  });

  function resetErrors() {
    setFormError(null);
    createMutation.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = strategyCreateSchema.safeParse({
      name,
      description: description.trim() || null,
      config: draftToStrategyConfig(config),
    });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Проверьте параметры стратегии");
      return;
    }
    createMutation.mutate(result.data);
  }

  return (
    <form className="space-y-[18px]" onSubmit={handleSubmit} noValidate>
      <EditorHeader pending={createMutation.isPending} />

      {(formError || createMutation.error) && (
        <FormError error={formError ?? createMutation.error} />
      )}

      <Card>
        <header className="border-b px-[18px] py-4">
          <h2 className="text-sm font-medium">Основное</h2>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Название и назначение стратегии внутри workspace.
          </p>
        </header>
        <CardContent className="grid gap-4 p-[18px] lg:grid-cols-2">
          <label className="space-y-2 text-xs font-medium text-secondary-foreground">
            Название
            <Input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                resetErrors();
              }}
              placeholder="Например, Trend following 15m"
              autoComplete="off"
              minLength={3}
              maxLength={80}
            />
          </label>
          <label className="space-y-2 text-xs font-medium text-secondary-foreground">
            Описание
            <Textarea
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                resetErrors();
              }}
              placeholder="Коротко опишите идею и условия применения"
              maxLength={500}
              className="min-h-20"
            />
          </label>
        </CardContent>
      </Card>

      <StrategyConfigEditor
        value={config}
        onChange={(nextConfig) => {
          setConfig(nextConfig);
          resetErrors();
        }}
      />

      <div className="flex items-center justify-end gap-3 pb-[18px]">
        <Button type="button" variant="ghost" asChild>
          <Link to="/strategies">Отмена</Link>
        </Button>
        <SubmitButton pending={createMutation.isPending} />
      </div>
    </form>
  );
}

function EditorHeader({ pending }: { pending: boolean }) {
  return (
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
        actions={<SubmitButton pending={pending} />}
      />
    </div>
  );
}

function SubmitButton({ pending }: { pending: boolean }) {
  return (
    <Button type="submit" disabled={pending}>
      {pending ? (
        <LoaderCircle className="animate-spin" aria-hidden="true" />
      ) : (
        <Check aria-hidden="true" />
      )}
      Создать черновик
    </Button>
  );
}

export function FormError({ error }: { error: unknown }) {
  const message =
    typeof error === "string"
      ? error
      : error instanceof ApiClientError
        ? error.message
        : "Не удалось сохранить стратегию";
  return (
    <div className="rounded-[10px] border border-loss/30 bg-loss/5 px-4 py-3 text-sm text-loss">
      {message}
    </div>
  );
}
