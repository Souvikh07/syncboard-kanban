import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { initDatabase } from "./db.js";
import { SSEBroker } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const mongoUri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/kanban";
const clientDistDir =
  process.env.NODE_ENV === "production" ? path.resolve(__dirname, "../../client/dist") : null;

async function main(): Promise<void> {
  const dbContext = await initDatabase(mongoUri);
  const sse = new SSEBroker({ heartbeatMs: 15_000 });
  const app = createApp({
    tasks: dbContext.tasks,
    sse,
    staticDir: clientDistDir,
  });

  const server = app.listen(port, () => {
    console.log(`Kanban server listening on http://localhost:${port}`);
  });

  function shutdown(): void {
    sse.close();
    server.close(() => {
      void dbContext.client.close().finally(() => {
        process.exit(0);
      });
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error("Failed to start Kanban server:", err);
  process.exit(1);
});
