import type { Response } from "express";
import type { SSEEvent } from "@kanban/shared";

interface StoredEvent {
  eventId: number;
  payload: SSEEvent;
}

const MAX_HISTORY = 500;
const DEFAULT_HEARTBEAT_MS = 15_000;

export class SSEBroker {
  private readonly clients = new Set<Response>();
  private readonly history: StoredEvent[] = [];
  private nextEventId = 1;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;

  constructor(options: { heartbeatMs?: number } = {}) {
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat();
      }, this.heartbeatMs);
      this.heartbeatTimer.unref();
    }
  }

  addClient(res: Response, lastEventIdRaw?: string | null): void {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    this.clients.add(res);
    res.write(": connected\n\n");

    if (lastEventIdRaw) {
      const parsed = Number.parseInt(lastEventIdRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        const missed = this.history.filter((entry) => entry.eventId > parsed);
        for (const entry of missed) {
          this.writeEvent(res, entry.eventId, entry.payload);
        }
      }
    }

    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  emit(payload: SSEEvent): number {
    const eventId = this.nextEventId++;
    this.history.push({ eventId, payload });
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    for (const client of this.clients) {
      this.writeEvent(client, eventId, payload);
    }

    return eventId;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  private sendHeartbeat(): void {
    for (const client of this.clients) {
      client.write(": heartbeat\n\n");
    }
  }

  private writeEvent(res: Response, eventId: number, payload: SSEEvent): void {
    res.write(`id: ${eventId}\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}
