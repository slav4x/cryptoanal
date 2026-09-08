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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ApiClientError, fetchAuthSession, login } from "../../shared/api";
import { AuthContext, authSessionQueryKey } from "./auth-context";

export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: authSessionQueryKey,
    queryFn: fetchAuthSession,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  useEffect(() => {
    const handleAuthRequired = () => void sessionQuery.refetch();
    window.addEventListener("cryptoanal:auth-required", handleAuthRequired);
    return () => window.removeEventListener("cryptoanal:auth-required", handleAuthRequired);
  }, [sessionQuery]);

  if (sessionQuery.isPending) return <AuthLoading />;
  if (sessionQuery.isError) {
    return (
      <AuthFrame>
        <Card className="w-full max-w-[420px]">
          <CardHeader>
            <CardTitle>Сервис авторизации недоступен</CardTitle>
            <CardDescription>Проверьте API и соединение с базой данных.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => void sessionQuery.refetch()}>
              Повторить
            </Button>
          </CardContent>
        </Card>
      </AuthFrame>
    );
  }
  if (!sessionQuery.data.data.authenticated) {
    return (
      <LoginPage onSuccess={(session) => queryClient.setQueryData(authSessionQueryKey, session)} />
    );
  }

  return <AuthContext.Provider value={sessionQuery.data.data}>{children}</AuthContext.Provider>;
}

function LoginPage({
  onSuccess,
}: {
  onSuccess: (session: Awaited<ReturnType<typeof login>>) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const loginMutation = useMutation({ mutationFn: login, onSuccess });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    loginMutation.mutate({ email, password });
  }

  const errorMessage =
    loginMutation.error instanceof ApiClientError
      ? loginMutation.error.message
      : loginMutation.isError
        ? "Не удалось выполнить вход"
        : null;

  return (
    <AuthFrame>
      <div className="w-full max-w-[420px]">
        <div className="mb-5 flex items-center gap-2 px-1">
          <span className="grid size-8 place-items-center rounded-[9px] bg-brand-mark text-background">
            <Activity className="size-[18px]" aria-hidden="true" />
          </span>
          <span className="text-sm font-medium tracking-[0.08em]">CRYPTOANAL</span>
        </div>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Вход в рабочее пространство</CardTitle>
            <CardDescription>
              Используйте учётную запись, созданную администратором.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={handleSubmit}>
              <label className="block space-y-1.5" htmlFor="email">
                <FieldLabel>Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoFocus
                />
              </label>
              <label className="block space-y-1.5" htmlFor="password">
                <FieldLabel>Пароль</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
              {errorMessage ? (
                <p className="text-sm text-loss" role="alert">
                  {errorMessage}
                </p>
              ) : null}
              <Button type="submit" className="w-full" disabled={loginMutation.isPending}>
                {loginMutation.isPending ? "Входим…" : "Войти"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Нет доступа? Обратитесь к администратору за одноразовой ссылкой восстановления.
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </AuthFrame>
  );
}

function AuthLoading() {
  return (
    <AuthFrame>
      <p className="text-sm text-muted-foreground">Проверяем сессию…</p>
    </AuthFrame>
  );
}

function AuthFrame({ children }: { children: ReactNode }) {
  return <main className="grid min-h-screen place-items-center bg-background p-6">{children}</main>;
}
