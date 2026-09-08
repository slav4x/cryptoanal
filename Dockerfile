FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.8.1 --activate

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile \
  && DATABASE_URL=postgresql://cryptoanal:cryptoanal@postgres:5432/cryptoanal_dev pnpm db:generate \
  && pnpm --filter @cryptoanal/api build \
  && pnpm --filter @cryptoanal/worker build \
  && pnpm --filter @cryptoanal/dashboard build

FROM workspace AS api

EXPOSE 3100

CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm exec tsx apps/api/src/server.ts"]

FROM workspace AS worker

CMD ["pnpm", "exec", "tsx", "apps/worker/src/worker.ts"]

FROM public.ecr.aws/docker/library/nginx:1.27-alpine AS dashboard

COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=workspace /app/apps/dashboard/dist /usr/share/nginx/html

EXPOSE 80
