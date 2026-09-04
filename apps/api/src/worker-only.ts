import { runWorkerOnly } from "./worker";
import { config } from "./config";

if (import.meta.main) {
  const worker = runWorkerOnly(config.databasePath);
  const shutdown = () => {
    console.log("[worker] shutting down");
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}