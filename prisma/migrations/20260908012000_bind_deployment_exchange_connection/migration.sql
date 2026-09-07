ALTER TABLE "Deployment"
ADD COLUMN "exchangeConnectionId" TEXT;

CREATE INDEX "Deployment_workspaceId_exchangeConnectionId_status_idx"
ON "Deployment"("workspaceId", "exchangeConnectionId", "status");

ALTER TABLE "Deployment"
ADD CONSTRAINT "Deployment_exchangeConnectionId_fkey"
FOREIGN KEY ("exchangeConnectionId") REFERENCES "ExchangeConnection"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
