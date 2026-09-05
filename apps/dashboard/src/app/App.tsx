import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { RouteFallback } from "./RouteFallback";

const OverviewPage = lazy(() => import("../features/overview/OverviewPage"));
const MarketsPage = lazy(() => import("../features/markets/MarketsPage"));
const MarketDetailPage = lazy(() => import("../features/markets/MarketDetailPage"));
const TradesPage = lazy(() => import("../features/trades/TradesPage"));
const TradeDetailPage = lazy(() => import("../features/trades/TradeDetailPage"));
const StrategiesPage = lazy(() => import("../features/strategies/StrategiesPage"));
const NewStrategyPage = lazy(() => import("../features/strategies/NewStrategyPage"));
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
            path="trades"
            element={
              <Suspense fallback={<RouteFallback />}>
                <TradesPage />
              </Suspense>
            }
          />
          <Route
            path="trades/:tradeId"
            element={
              <Suspense fallback={<RouteFallback />}>
                <TradeDetailPage />
              </Suspense>
            }
          />
          <Route
            path="strategies"
            element={
              <Suspense fallback={<RouteFallback />}>
                <StrategiesPage />
              </Suspense>
            }
          />
          <Route
            path="strategies/new"
            element={
              <Suspense fallback={<RouteFallback />}>
                <NewStrategyPage />
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
