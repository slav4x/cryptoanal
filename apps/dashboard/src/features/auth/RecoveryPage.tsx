import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
} from "@cryptoanal/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiClientError, fetchPasswordRecovery, recoverPassword } from "../../shared/api";

export default function RecoveryPage() {
  const { token = "" } = useParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const recoveryQuery = useQuery({
    queryKey: ["password-recovery", token],
    queryFn: () => fetchPasswordRecovery(token),
    retry: false,
    enabled: Boolean(token),
  });
  const mutation = useMutation({
    mutationFn: () => recoverPassword(token, { newPassword: password }),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) return;
    mutation.mutate();
  }

  const mismatch = confirmation.length > 0 && password !== confirmation;
  const errorMessage =
    mutation.error instanceof ApiClientError
      ? mutation.error.message
      : mutation.isError
        ? "Не удалось изменить пароль"
        : null;

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-5 flex items-center gap-2 px-1">
          <span className="grid size-8 place-items-center rounded-[9px] bg-brand-mark text-background">
            <Activity className="size-[18px]" aria-hidden="true" />
          </span>
          <span className="text-sm font-medium tracking-[0.08em]">CRYPTOANAL</span>
        </div>
        <Card>
          {mutation.isSuccess ? (
            <CardContent className="space-y-4 pt-6">
              <CheckCircle2 className="size-6 text-profit" aria-hidden="true" />
              <div>
                <CardTitle>Пароль изменён</CardTitle>
                <CardDescription className="mt-1.5">
                  Все прежние сессии завершены. Войдите с новым паролем.
                </CardDescription>
              </div>
              <Button asChild className="w-full">
                <Link to="/">Перейти ко входу</Link>
              </Button>
            </CardContent>
          ) : recoveryQuery.isPending ? (
            <CardContent className="pt-6 text-sm text-muted-foreground">
              Проверяем ссылку…
            </CardContent>
          ) : recoveryQuery.isError ? (
            <CardContent className="space-y-4 pt-6">
              <div>
                <CardTitle>Ссылка недействительна</CardTitle>
                <CardDescription className="mt-1.5">
                  Запросите у администратора новую ссылку восстановления.
                </CardDescription>
              </div>
              <Button asChild variant="secondary" className="w-full">
                <Link to="/">Вернуться ко входу</Link>
              </Button>
            </CardContent>
          ) : (
            <>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Новый пароль</CardTitle>
                <CardDescription>
                  Учётная запись {recoveryQuery.data.data.emailHint}. После сохранения все активные
                  сессии будут завершены.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={handleSubmit}>
                  <label className="block space-y-1.5" htmlFor="recovery-password">
                    <FieldLabel>Новый пароль</FieldLabel>
                    <Input
                      id="recovery-password"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      autoFocus
                    />
                  </label>
                  <label className="block space-y-1.5" htmlFor="recovery-confirmation">
                    <FieldLabel>Повторите пароль</FieldLabel>
                    <Input
                      id="recovery-confirmation"
                      type="password"
                      autoComplete="new-password"
                      minLength={12}
                      maxLength={256}
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      required
                    />
                  </label>
                  {mismatch ? (
                    <p className="text-sm text-loss" role="alert">
                      Пароли не совпадают
                    </p>
                  ) : null}
                  {errorMessage ? (
                    <p className="text-sm text-loss" role="alert">
                      {errorMessage}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={mutation.isPending || mismatch || password.length < 12}
                  >
                    {mutation.isPending ? "Сохраняем…" : "Сохранить пароль"}
                  </Button>
                </form>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
