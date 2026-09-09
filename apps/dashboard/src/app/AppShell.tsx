import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@cryptoanal/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ListTree,
  ArrowLeftRight,
  BookOpenText,
  BookMarked,
  ChartNoAxesCombined,
  FlaskConical,
  HeartPulse,
  Layers3,
  LayoutDashboard,
  Menu,
  LogOut,
  RadioTower,
  Settings,
  ScrollText,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { fetchOverview, fetchSettings, logout, switchWorkspace } from "../shared/api";
import { authSessionQueryKey, useAuthSession } from "../features/auth/auth-context";

const workspaceNavigation = [
  { label: "Главная", href: "/", icon: LayoutDashboard, end: true },
  { label: "Рынки", href: "/markets", icon: Activity, end: false },
  { label: "Сделки", href: "/trades", icon: ArrowLeftRight, end: false },
  { label: "Стратегии", href: "/strategies", icon: Layers3, end: false },
  { label: "Валидация", href: "/validation", icon: FlaskConical, end: false },
  { label: "Запуск", href: "/runtime", icon: RadioTower, end: false },
  { label: "Аналитика", href: "/analytics", icon: ChartNoAxesCombined, end: true },
] satisfies NavigationItem[];

const researchNavigation = [
  { label: "Активность", href: "/activity", icon: ListTree, end: false },
  { label: "Разбор", href: "/journal", icon: BookOpenText, end: false },
  { label: "Плейбуки", href: "/playbooks", icon: BookMarked, end: false },
] satisfies NavigationItem[];

const systemNavigation = [
  { label: "Состояние", href: "/analytics/health", icon: HeartPulse, end: false },
  { label: "Системные логи", href: "/system/logs", icon: ScrollText, end: false },
  { label: "Настройки", href: "/settings", icon: Settings, end: false },
] satisfies NavigationItem[];

type NavigationItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  end: boolean;
};

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const session = useAuthSession();
  const queryClient = useQueryClient();
  const location = useLocation();
  const runtimePollingEnabled =
    location.pathname === "/" ||
    location.pathname.startsWith("/runtime") ||
    location.pathname.startsWith("/trades");
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: () => fetchOverview(),
    refetchInterval: runtimePollingEnabled ? 15_000 : false,
    refetchIntervalInBackground: false,
  });
  const settingsQuery = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    staleTime: 60_000,
  });

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    const density = settingsQuery.data?.data.preferences.tableDensity;
    if (density) document.documentElement.dataset.density = density;
  }, [settingsQuery.data?.data.preferences.tableDensity]);

  const switchMutation = useMutation({
    mutationFn: switchWorkspace,
    onSuccess: (response) => {
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== authSessionQueryKey[0],
      });
      queryClient.setQueryData(authSessionQueryKey, response);
    },
  });
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: (response) => {
      queryClient.clear();
      queryClient.setQueryData(authSessionQueryKey, response);
    },
  });
  const runtimeState = overviewQuery.data?.data.runtimeState ?? "offline";

  return (
    <div className="min-h-screen bg-background lg:flex lg:gap-[22px] lg:p-[18px_22px]">
      <a
        href="#main-content"
        className="sr-only fixed left-4 top-4 z-[100] rounded-[8px] bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only"
      >
        Перейти к содержанию
      </a>
      <aside className="sticky top-[18px] hidden h-[calc(100vh-36px)] w-(--sidebar-width) shrink-0 lg:flex lg:flex-col">
        <SidebarContent
          session={session}
          runtimeState={runtimeState}
          switching={switchMutation.isPending}
          loggingOut={logoutMutation.isPending}
          onWorkspaceChange={(workspaceId) => switchMutation.mutate(workspaceId)}
          onLogout={() => logoutMutation.mutate()}
          onNavigate={() => undefined}
        />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            className="absolute inset-0 bg-background/85 backdrop-blur-sm"
            aria-label="Закрыть навигацию"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative flex h-full w-[min(17rem,85vw)] flex-col border-r border-sidebar-border bg-sidebar p-[18px]">
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-3"
              aria-label="Закрыть навигацию"
              onClick={() => setMobileOpen(false)}
            >
              <X />
            </Button>
            <SidebarContent
              session={session}
              runtimeState={runtimeState}
              switching={switchMutation.isPending}
              loggingOut={logoutMutation.isPending}
              onWorkspaceChange={(workspaceId) => switchMutation.mutate(workspaceId)}
              onLogout={() => logoutMutation.mutate()}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-(--header-height) items-center justify-between border-b bg-background/95 px-4 backdrop-blur-md lg:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Открыть навигацию"
            onClick={() => setMobileOpen(true)}
          >
            <Menu />
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium tracking-[0.08em]">CRYPTOANAL</span>
            <Badge variant="outline">dry-run</Badge>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="w-full p-4 sm:p-6 lg:p-0">
          <Outlet key={session.activeWorkspace.id} />
        </main>
      </div>
    </div>
  );
}

type SidebarContentProps = {
  session: ReturnType<typeof useAuthSession>;
  runtimeState: "offline" | "idle" | "running" | "paused" | "error";
  switching: boolean;
  loggingOut: boolean;
  onWorkspaceChange: (workspaceId: string) => void;
  onLogout: () => void;
  onNavigate: () => void;
};

const runtimeLabels: Record<SidebarContentProps["runtimeState"], string> = {
  offline: "не отвечает",
  idle: "работает",
  running: "выполняет задачу",
  paused: "приостановлен",
  error: "ошибка",
};

function SidebarContent({
  session,
  runtimeState,
  switching,
  loggingOut,
  onWorkspaceChange,
  onLogout,
  onNavigate,
}: SidebarContentProps) {
  const runtimeIsHealthy = runtimeState === "idle" || runtimeState === "running";

  return (
    <>
      <div className="flex items-center gap-2 px-1 py-0.5">
        <span className="grid size-7 place-items-center rounded-[8px] bg-brand-mark text-background">
          <Activity className="size-[17px]" aria-hidden="true" />
        </span>
        <span className="text-sm font-medium tracking-[0.08em] text-sidebar-foreground">
          CRYPTOANAL
        </span>
      </div>

      <Select
        value={session.activeWorkspace.id}
        disabled={switching}
        onValueChange={onWorkspaceChange}
      >
        <SelectTrigger className="mt-4 h-10 bg-card" aria-label="Рабочее пространство">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {session.workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <nav
        className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1"
        aria-label="Основная навигация"
      >
        <NavigationGroup
          label="Рабочая область"
          items={workspaceNavigation}
          onNavigate={onNavigate}
        />
        <NavigationGroup label="Исследования" items={researchNavigation} onNavigate={onNavigate} />
        <NavigationGroup label="Система" items={systemNavigation} onNavigate={onNavigate} />
      </nav>

      <div className="mt-3">
        <div className="flex items-center justify-between px-0.5" aria-live="polite">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn("size-1.5 rounded-full", runtimeIsHealthy ? "bg-profit" : "bg-loss")}
              aria-hidden="true"
            />
            {runtimeLabels[runtimeState]}
          </span>
          <span className="rounded-[6px] border border-input bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
            dry-run
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-sidebar-border pt-3">
          <div className="min-w-0">
            <p className="truncate text-xs text-sidebar-foreground">{session.user.displayName}</p>
            <p className="truncate text-[10px] text-muted-foreground">{session.user.email}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Выйти"
            disabled={loggingOut}
            onClick={onLogout}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </>
  );
}

function NavigationGroup({
  label,
  items,
  onNavigate,
}: {
  label: string;
  items: NavigationItem[];
  onNavigate: () => void;
}) {
  return (
    <div>
      <p className="mb-0.5 px-[11px] text-[9px] uppercase tracking-[0.14em] text-stale">{label}</p>
      <div className="space-y-0.5">
        {items.map(({ label: itemLabel, href, icon: Icon, end }) => (
          <NavLink
            key={href}
            to={href}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex h-8 items-center gap-[10px] rounded-[8px] px-[11px] text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                isActive && "bg-sidebar-accent text-sidebar-foreground",
              )
            }
          >
            <Icon className="size-4" aria-hidden="true" />
            {itemLabel}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
