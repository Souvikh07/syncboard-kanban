import type { NextFunction, Request, Response } from "express";

export interface MutationMetadata {
  originClientId: string | null;
  mutationId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mutationMeta?: MutationMetadata;
    }
  }
}

export function extractMutationMeta(req: Request, _res: Response, next: NextFunction): void {
  const clientIdHeader = req.header("X-Client-Id");
  const mutationIdHeader = req.header("X-Mutation-Id");

  req.mutationMeta = {
    originClientId: clientIdHeader && clientIdHeader.trim() ? clientIdHeader.trim() : null,
    mutationId: mutationIdHeader && mutationIdHeader.trim() ? mutationIdHeader.trim() : null,
  };
  next();
}

export interface FailureInjectionOptions {
  failRate: number;
  minLatencyMs: number;
  maxLatencyMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createFailureInjectionMiddleware(options: FailureInjectionOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const isMutation = req.method === "POST" || req.method === "PATCH" || req.method === "DELETE";
    if (!isMutation) {
      next();
      return;
    }

    const { minLatencyMs, maxLatencyMs, failRate } = options;
    if (maxLatencyMs > 0) {
      const span = Math.max(0, maxLatencyMs - minLatencyMs);
      const delay = minLatencyMs + Math.floor(Math.random() * (span + 1));
      if (delay > 0) {
        await sleep(delay);
      }
    }

    const forceFail = req.query.fail === "1" || req.query.fail === "true";
    if (forceFail || (failRate > 0 && Math.random() < failRate)) {
      res.status(500).json({
        error: forceFail
          ? "Simulated server failure (?fail=1)"
          : "Simulated transient server failure (FAIL_RATE)",
      });
      return;
    }

    next();
  };
}
