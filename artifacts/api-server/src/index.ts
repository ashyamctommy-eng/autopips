import app from "./app";
import { logger } from "./lib/logger";
import { missingConfiguration } from "./migration-api";
import { serverEnv } from "./imported/lib/env";
import { bootstrapProductionAdmin } from "./bootstrap-admin";
import { startTelemetrySubscriber } from "./imported/server/modules/telemetry/telemetry.events";

// Preview may show public content during setup. A published money-handling
// server must never advertise readiness with missing credentials.
if (process.env.NODE_ENV === 'production' && missingConfiguration().length) {
  throw new Error(`Missing service configuration: ${missingConfiguration().join(', ')}`);
}
if (process.env.NODE_ENV === 'production') serverEnv();
await bootstrapProductionAdmin();
void startTelemetrySubscriber();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
