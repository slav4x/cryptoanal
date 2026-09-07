-- Exchange credentials belong only to external demo/live accounts.
ALTER TABLE "ExchangeConnection"
ADD CONSTRAINT "ExchangeConnection_environment_check"
CHECK ("environment" IN ('DEMO', 'LIVE'));
