import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
  Skeleton,
} from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, Users } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { acceptInvitation, ApiClientError, fetchInvitation } from "../../shared/api";
import { authSessionQueryKey } from "./auth-context";

export default function InvitationPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const invitationQuery = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => fetchInvitation(token),
    enabled: Boolean(token),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () =>
      acceptInvitation(token, {
        password,
        ...(invitationQuery.data?.data.existingUser ? {} : { displayName }),
      }),
    onSuccess: (session) => {
      queryClient.setQueryData(authSessionQueryKey, session);
      navigate("/", { replace: true });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-[440px]">
        <div className="mb-5 flex items-center gap-2 px-1">
          <span className="grid size-8 place-items-center rounded-[9px] bg-brand-mark text-background">
            <Activity className="size-[18px]" aria-hidden="true" />
          </span>
          <span className="text-sm font-medium tracking-[0.08em]">CRYPTOANAL</span>
        </div>
        {invitationQuery.isPending ? (
          <Skeleton className="h-[360px] w-full" />
        ) : invitationQuery.isError ? (
          <Card>
            <CardHeader>
              <CardTitle>Приглашение недоступно</CardTitle>
              <CardDescription>Ссылка истекла, была отозвана или уже использована.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="w-full" variant="secondary">
                <Link to="/">Перейти ко входу</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader className="border-b">
              <div className="mb-2 flex items-center justify-between gap-4">
                <span className="grid size-9 place-items-center rounded-[9px] bg-secondary text-muted-foreground">
                  <Users className="size-[18px]" />
                </span>
                <Badge variant="outline">
                  {invitationQuery.data.data.role === "owner" ? "владелец" : "участник"}
                </Badge>
              </div>
              <CardTitle>Приглашение в {invitationQuery.data.data.workspace.name}</CardTitle>
              <CardDescription>{invitationQuery.data.data.email}</CardDescription>
            </CardHeader>
            <CardContent className="pt-5">
              <form className="space-y-4" onSubmit={handleSubmit}>
                {!invitationQuery.data.data.existingUser ? (
                  <label className="block space-y-1.5" htmlFor="display-name">
                    <FieldLabel>Имя</FieldLabel>
                    <Input
                      id="display-name"
                      value={displayName}
                      minLength={2}
                      maxLength={120}
                      autoComplete="name"
                      onChange={(event) => setDisplayName(event.target.value)}
                      required
                      autoFocus
                    />
                  </label>
                ) : null}
                <label className="block space-y-1.5" htmlFor="invite-password">
                  <FieldLabel>
                    {invitationQuery.data.data.existingUser
                      ? "Пароль учётной записи"
                      : "Придумайте пароль"}
                  </FieldLabel>
                  <Input
                    id="invite-password"
                    type="password"
                    value={password}
                    minLength={12}
                    maxLength={256}
                    autoComplete={
                      invitationQuery.data.data.existingUser ? "current-password" : "new-password"
                    }
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    autoFocus={invitationQuery.data.data.existingUser}
                  />
                  {!invitationQuery.data.data.existingUser ? (
                    <span className="block text-[10px] text-stale">Минимум 12 символов</span>
                  ) : null}
                </label>
                {mutation.isError ? (
                  <p className="text-sm text-loss" role="alert">
                    {mutation.error instanceof ApiClientError
                      ? mutation.error.message
                      : "Не удалось принять приглашение"}
                  </p>
                ) : null}
                <Button type="submit" className="w-full" disabled={mutation.isPending}>
                  {mutation.isPending ? "Подключаем…" : "Принять приглашение"}
                  {!mutation.isPending ? <ArrowRight className="size-4" /> : null}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
