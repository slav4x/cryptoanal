import {
  strategyConfigSchema,
  strategyVersionCreateSchema,
  type StrategyDetailDto,
  type StrategyVersionDetailDto,
} from "@cryptoanal/contracts";
import { Button, Card, CardContent, Input, PageHeader, Skeleton } from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, LoaderCircle } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiClientError, createStrategyVersion, fetchStrategyDetail } from "../../shared/api";
import { FormError } from "./NewStrategyPage";
import { draftToStrategyConfig, strategyConfigToDraft } from "./strategy-config-form";
import { StrategyConfigEditor } from "./StrategyConfigEditor";

export default function NewStrategyVersionPage() {
  const { strategyId = "" } = useParams();
  const strategyQuery = useQuery({
    queryKey: ["strategy", strategyId],
    queryFn: () => fetchStrategyDetail(strategyId),
    enabled: Boolean(strategyId),
  });

  if (strategyQuery.isPending) return <EditorSkeleton />;
  if (strategyQuery.isError)
    return <LoadError strategyId={strategyId} error={strategyQuery.error} />;

  const strategy = strategyQuery.data.data;
  const latestVersion = strategy.versions[0];
  if (!latestVersion) {
    return (
      <LoadError strategyId={strategyId} error={new Error("У стратегии нет исходной версии")} />
    );
  }

  return (
    <VersionEditor
      key={latestVersion.id}
      strategyId={strategyId}
      strategy={strategy}
      latestVersion={latestVersion}
    />
  );
}

function VersionEditor({
  strategyId,
  strategy,
  latestVersion,
}: {
  strategyId: string;
  strategy: StrategyDetailDto;
  latestVersion: StrategyVersionDetailDto;
}) {
  const [draft, setDraft] = useState(() => strategyConfigToDraft(latestVersion.config));
  const [changeSummary, setChangeSummary] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const createMutation = useMutation({
    mutationFn: (payload: Parameters<typeof createStrategyVersion>[1]) =>
      createStrategyVersion(strategyId, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["strategy", strategyId] });
      void queryClient.invalidateQueries({ queryKey: ["strategies"] });
      navigate(`/strategies/${strategyId}?tab=versions`);
    },
  });
  const nextVersion = latestVersion.version + 1;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const configResult = strategyConfigSchema.safeParse(draftToStrategyConfig(draft));
    if (!configResult.success) {
      setFormError(configResult.error.issues[0]?.message ?? "Проверьте параметры стратегии");
      return;
    }
    const payloadResult = strategyVersionCreateSchema.safeParse({
      config: configResult.data,
      changeSummary,
    });
    if (!payloadResult.success) {
      setFormError(payloadResult.error.issues[0]?.message ?? "Укажите причину изменений");
      return;
    }
    createMutation.mutate(payloadResult.data);
  }

  function resetErrors() {
    setFormError(null);
    createMutation.reset();
  }

  return (
    <form className="space-y-[18px]" onSubmit={handleSubmit} noValidate>
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" asChild className="mt-5 shrink-0">
          <Link to={`/strategies/${strategyId}?tab=versions`} aria-label="Вернуться к стратегии">
            <ArrowLeft aria-hidden="true" />
          </Link>
        </Button>
        <PageHeader
          eyebrow={strategy.name}
          title={`Новая версия v${nextVersion}`}
          description={`Редактор открыт на основе v${latestVersion.version}. Исходная версия останется без изменений.`}
          actions={<SubmitButton pending={createMutation.isPending} />}
        />
      </div>

      {(formError || createMutation.error) && (
        <FormError error={formError ?? createMutation.error} />
      )}

      <Card>
        <header className="border-b px-[18px] py-4">
          <h2 className="text-sm font-medium">Причина изменения</h2>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Короткое описание попадёт в историю версий и поможет читать diff.
          </p>
        </header>
        <CardContent className="p-[18px]">
          <Input
            value={changeSummary}
            onChange={(event) => {
              setChangeSummary(event.target.value);
              resetErrors();
            }}
            placeholder="Например, уменьшен риск на сделку"
            minLength={3}
            maxLength={300}
          />
        </CardContent>
      </Card>

      <StrategyConfigEditor
        value={draft}
        onChange={(nextDraft) => {
          setDraft(nextDraft);
          resetErrors();
        }}
      />

      <div className="flex items-center justify-end gap-3 pb-[18px]">
        <Button type="button" variant="ghost" asChild>
          <Link to={`/strategies/${strategyId}?tab=versions`}>Отмена</Link>
        </Button>
        <SubmitButton pending={createMutation.isPending} />
      </div>
    </form>
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
      Сохранить новую версию
    </Button>
  );
}

function LoadError({ strategyId, error }: { strategyId: string; error: Error }) {
  return (
    <div className="space-y-[18px]">
      <PageHeader title="Стратегия недоступна" description={error.message} />
      <div className="flex gap-3">
        <Button variant="outline" asChild>
          <Link to="/strategies">К каталогу</Link>
        </Button>
        {error instanceof ApiClientError && error.requestId ? (
          <span className="self-center font-mono text-xs text-stale">
            request {error.requestId}
          </span>
        ) : null}
      </div>
      {strategyId ? null : <p className="text-sm text-loss">Не передан ID стратегии.</p>}
    </div>
  );
}

function EditorSkeleton() {
  return (
    <div className="space-y-[18px]">
      <Skeleton className="h-24" />
      <Skeleton className="h-28" />
      <Skeleton className="h-64" />
    </div>
  );
}
