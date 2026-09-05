import { Badge, Button, cn } from "@cryptoanal/ui";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowLeftRight,
  Box,
  ChevronsUpDown,
  LayoutDashboard,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { fetchOverview, fetchRequestContext } from "../shared/api";

const navigation = [
  { label: "Главная", href: "/", icon: LayoutDashboard, end: true },
  { label: "Рынки", href: "/markets", icon: Activity, end: false },
  { label: "Сделки", href: "/trades", icon: ArrowLeftRight, end: false },
] as const;

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const contextQuery = useQuery({
    queryKey: ["context"],
    queryFn: fetchRequestContext,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const overviewQuery = useQuery({
    queryKey: ["overview"],
    queryFn: fetchOverview,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const workspaceName = contextQuery.data?.data.workspaceName;
  const runtimeState = overviewQuery.data?.data.runtimeState ?? "offline";

  return (
    <div className="min-h-screen bg-background lg:flex lg:gap-[22px] lg:p-[18px_22px]">
      <aside className="sticky top-[18px] hidden h-[calc(100vh-36px)] w-(--sidebar-width) shrink-0 lg:flex lg:flex-col">
        <SidebarContent
          workspaceName={workspaceName}
          runtimeState={runtimeState}
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
              workspaceName={workspaceName}
              runtimeState={runtimeState}
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

        <main className="w-full p-4 sm:p-6 lg:p-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

type SidebarContentProps = {
  workspaceName?: string | undefined;
  runtimeState: "offline" | "idle" | "running" | "paused" | "error";
  onNavigate: () => void;
};

const runtimeLabels: Record<SidebarContentProps["runtimeState"], string> = {
  offline: "не отвечает",
  idle: "работает",
  running: "выполняет задачу",
  paused: "приостановлен",
  error: "ошибка",
};

function SidebarContent({ workspaceName, runtimeState, onNavigate }: SidebarContentProps) {
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

      <div className="mt-4 flex min-h-10 w-full items-center justify-between gap-1.5 rounded-[10px] border border-input bg-card px-[11px] py-2 text-[13px]">
        <span className="flex min-w-0 items-center gap-2">
          <Box className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{workspaceName ?? "Development workspace"}</span>
        </span>
        <ChevronsUpDown className="size-[15px] shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>

      <nav className="mt-4 flex flex-col gap-0.5" aria-label="Основная навигация">
        {navigation.map(({ label, href, icon: Icon, end }) => (
          <NavLink
            key={href}
            to={href}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex h-10 items-center gap-[11px] rounded-[9px] px-[11px] text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                isActive && "bg-sidebar-accent text-sidebar-foreground",
              )
            }
          >
            <Icon className="size-[17px]" aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-2.5">
        <div className="flex items-center justify-between px-0.5">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn("size-1.5 rounded-full", runtimeIsHealthy ? "bg-profit" : "bg-loss")}
            />
            {runtimeLabels[runtimeState]}
          </span>
          <span className="rounded-[6px] border border-input bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
            dry-run
          </span>
        </div>
        <div className="flex items-center gap-2.5 rounded-[12px] border border-input bg-card p-2.5">
          <span className="grid size-8 place-items-center rounded-full bg-avatar text-[13px] font-medium text-avatar-foreground">
            D
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium">Development</span>
            <span className="block truncate text-[11px] text-stale">локальный workspace</span>
          </span>
        </div>
      </div>
    </>
  );
}
