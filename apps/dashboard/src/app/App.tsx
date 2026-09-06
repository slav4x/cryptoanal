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
const StrategyDetailPage = lazy(() => import("../features/strategies/StrategyDetailPage"));
const NewStrategyVersionPage = lazy(() => import("../features/strategies/NewStrategyVersionPage"));
const ValidationPage = lazy(() => import("../features/validation/ValidationPage"));
const ValidationRunPage = lazy(() => import("../features/validation/ValidationRunPage"));
const ValidationComparePage = lazy(() => import("../features/validation/ValidationComparePage"));
const RuntimePage = lazy(() => import("../features/runtime/RuntimePage"));
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
            path="strategies/:strategyId"
            element={
              <Suspense fallback={<RouteFallback />}>
                <StrategyDetailPage />
              </Suspense>
            }
          />
          <Route
            path="strategies/:strategyId/versions/new"
            element={
              <Suspense fallback={<RouteFallback />}>
                <NewStrategyVersionPage />
              </Suspense>
            }
          />
          <Route
            path="validation"
            element={
              <Suspense fallback={<RouteFallback />}>
                <ValidationPage />
              </Suspense>
            }
          />
          <Route
            path="validation/compare"
            element={
              <Suspense fallback={<RouteFallback />}>
                <ValidationComparePage />
              </Suspense>
            }
          />
          <Route
            path="validation/:validationRunId"
            element={
              <Suspense fallback={<RouteFallback />}>
                <ValidationRunPage />
              </Suspense>
            }
          />
          <Route
            path="runtime"
            element={
              <Suspense fallback={<RouteFallback />}>
                <RuntimePage />
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
