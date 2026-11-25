import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { initDatabase } from "./db.js";
import { SSEBroker } from "./sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const dbPath = process.env.DB_PATH ?? path.resolve(__dirname, "../../data/kanban.db");
const clientDistDir =
  process.env.NODE_ENV === "production" ? path.resolve(__dirname, "../../client/dist") : null;

const db = initDatabase(dbPath);
const sse = new SSEBroker({ heartbeatMs: 15_000 });
const app = createApp({
  db,
  sse,
  staticDir: clientDistDir,
});

const server = app.listen(port, () => {
  console.log(`Kanban server listening on http://localhost:${port}`);
});

function shutdown(): void {
  sse.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
