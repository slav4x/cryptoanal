import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { RouteFallback } from "./RouteFallback";

const OverviewPage = lazy(() => import("../features/overview/OverviewPage"));
const MarketsPage = lazy(() => import("../features/markets/MarketsPage"));
const MarketDetailPage = lazy(() => import("../features/markets/MarketDetailPage"));
const NotFoundPage = lazy(() => import("../features/not-found/NotFoundPage"));

export function App() {
  return (
    <AppErrorBoundary>
      <Routes>
        <Route element={<AppShell />}>
          <Route
            index
            element={
              <Suspense fallback={<RouteFallback />}>
                <OverviewPage />
              </Suspense>
            }
          />
          <Route
            path="markets"
            element={
              <Suspense fallback={<RouteFallback />}>
                <MarketsPage />
              </Suspense>
            }
          />
          <Route
            path="markets/:symbol"
            element={
              <Suspense fallback={<RouteFallback />}>
                <MarketDetailPage />
              </Suspense>
            }
          />
          <Route
            path="*"
            element={
              <Suspense fallback={<RouteFallback />}>
                <NotFoundPage />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </AppErrorBoundary>
  );
}
