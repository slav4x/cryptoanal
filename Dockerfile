FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS dependencies

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.8.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY packages/application/package.json ./packages/application/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/exchange-bybit/package.json ./packages/exchange-bybit/package.json
COPY packages/persistence/package.json ./packages/persistence/package.json
COPY packages/ui/package.json ./packages/ui/package.json

RUN pnpm install --frozen-lockfile

FROM dependencies AS generated

COPY prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma

RUN DATABASE_URL=postgresql://cryptoanal:cryptoanal@postgres:5432/cryptoanal_dev pnpm db:generate

FROM generated AS workspace

COPY . .

FROM workspace AS api

RUN pnpm --filter @cryptoanal/api build

EXPOSE 3100

CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm exec tsx apps/api/src/server.ts"]

FROM workspace AS worker

RUN pnpm --filter @cryptoanal/worker build

CMD ["pnpm", "exec", "tsx", "apps/worker/src/worker.ts"]

FROM workspace AS trade-auditor

RUN pnpm exec tsc --project scripts/trade-monitor.tsconfig.json

CMD ["node", "--max-old-space-size=256", "--import=tsx", "scripts/watch-trade-audits.ts", "development", "/audit/acceptance-n01-2026-10-16.json", "/audit/trade-monitor"]

FROM workspace AS dashboard-build

RUN pnpm --filter @cryptoanal/dashboard build

FROM public.ecr.aws/docker/library/nginx:1.27-alpine AS dashboard

COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=dashboard-build /app/apps/dashboard/dist /usr/share/nginx/html

EXPOSE 80
