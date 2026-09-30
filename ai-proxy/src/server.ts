import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import cors from "cors";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { categorize } from "./categorize.js";
import type {
  CategorizeRequest,
  ItemMatch,
} from "./types.js";

const PORT = Number(process.env.PORT ?? 8787);

// Models advertised to the extension. Anything reachable on the
// Anthropic-compatible endpoint is allowed; we just narrow the picker.
// Order = default recommendation order: newest flash-preview tier first
// (so the operator sees it without scrolling), then the production
// default (M3, recommended), then highspeed variants, then older tiers.
const ADVERTISED_MODELS = [
  { id: "MiniMax-M3.1-Flash-Preview", label: "MiniMax-M3.1-Flash-Preview (newest flash preview)" },
  { id: "MiniMax-M3", label: "MiniMax-M3 (default · 1M ctx)", recommended: true },
  { id: "MiniMax-M2.7-highspeed", label: "MiniMax-M2.7-highspeed (faster)" },
  { id: "MiniMax-M2.7", label: "MiniMax-M2.7" },
  { id: "MiniMax-M2.5-highspeed", label: "MiniMax-M2.5-highspeed" },
  { id: "MiniMax-M2.5", label: "MiniMax-M2.5" },
  { id: "MiniMax-M2.1-highspeed", label: "MiniMax-M2.1-highspeed" },
  { id: "MiniMax-M2.1", label: "MiniMax-M2.1" },
  { id: "MiniMax-M2", label: "MiniMax-M2" },
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[fatal] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

requireEnv("ANTHROPIC_API_KEY");

const client = new Anthropic(); // picks up ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL

const app = express();
app.use(express.json({ limit: "8mb" }));

const allowed = (process.env.PROXY_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // No Origin header (curl, server-to-server): allow.
      if (!origin) return cb(null, true);
      if (allowed.length === 0 || allowed.includes("*")) return cb(null, true);
      const ok = allowed.some((pattern) => matchOrigin(pattern, origin));
      cb(ok ? null : new Error(`origin not allowed: ${origin}`), ok);
    },
  }),
);

function matchOrigin(pattern: string, origin: string): boolean {
  // tiny glob: * matches anything except '/', so chrome-extension://* covers any ext id.
  if (!pattern.includes("*")) return pattern === origin;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]+");
  return new RegExp(`^${escaped}$`).test(origin);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, models: ADVERTISED_MODELS.length });
});

app.get("/models", (_req, res) => {
  res.json({
    default: process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3",
    models: ADVERTISED_MODELS,
  });
});

// /categorize streams Server-Sent Events so the extension UI sees
// per-batch progress instead of waiting silently for the entire
// multi-batch run to complete. Events:
//   event: batch-start    data: { i, total, size }
//   event: batch-done     data: { i, total, matches, accumulated }
//   event: batch-timeout  data: { i, total, timeoutMs, consecutiveTimeouts }
//   event: done           data: { model, batches, items, matches, partial?, failedBatches? }
//   event: error          data: { error }
//   comment lines (": heartbeat ...") keep the connection warm.
//
// Note: `batch-done` ships the FULL matches array (not just a count) so the
// extension can persist each completed batch incrementally. Previously the
// payload was `{ i, total, matches: matches.length, accumulated }` and the
// extension only had access to the matches at the terminal `done` event —
// so any timeout / error in the middle of the run discarded all earlier
// batches. See `docs/SAFETY-CONTRACT.md` §3 (operator never loses data).
app.post("/categorize", async (req: Request, res: Response) => {
  const body = req.body as CategorizeRequest;
  if (!body || !Array.isArray(body.items) || !Array.isArray(body.customers)) {
    res.status(400).json({ error: "items[] and customers[] are required" });
    return;
  }
  if (body.items.length === 0) {
    res.status(400).json({ error: "items[] is empty" });
    return;
  }

  // SSE headers
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx: disable buffering
  res.flushHeaders?.();

  // Detect a real client disconnect: Node 18+ fires `req.on("close")`
  // eagerly on keep-alive sockets (right after the body is read), which
  // doesn't actually mean the client is gone. Instead, listen on `res.on
  // ("close")`, which only fires once the underlying socket is closed in
  // both directions. We also short-circuit writes when `res.writableEnded`
  // is true, since by then there's nobody listening.
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) clientGone = true;
  });

  const write = (event: string, data: unknown) => {
    if (clientGone || res.writableEnded) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try {
      res.write(payload);
    } catch {
      // Socket is dead — flip the flag so the rest of the run short-circuits.
      clientGone = true;
      return;
    }
    // Best-effort flush so the chunk reaches the client before the
    // connection closes — without this, the error path that ends the
    // response immediately can lose its `error` event.
    const maybeFlush = (res as unknown as { flush?: () => void }).flush;
    if (typeof maybeFlush === "function") {
      try {
        maybeFlush.call(res);
      } catch {
        /* compression middleware or older Node may not support flush */
      }
    }
  };

  // Heartbeat every 15s — keeps proxies / browsers from killing the
  // connection while a long MiniMax batch is in flight.
  const heartbeat = setInterval(() => {
    if (clientGone || res.writableEnded) return;
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
      const maybeFlush = (res as unknown as { flush?: () => void }).flush;
      if (typeof maybeFlush === "function") maybeFlush.call(res);
    } catch {
      /* socket closed mid-write — catch block below will fire */
    }
  }, 15_000);

  try {
    const allMatches: ItemMatch[] = [];
    let lastTotal = 0;
    let lastSize = 0;
    let partial = false;
    let failedBatches: Array<{ batchIndex: number; error: string }> | undefined;

    const result = await categorize(
      client,
      {
        items: body.items,
        customers: body.customers,
        model: body.model,
        overrides: body.overrides ?? [],
      },
      {
        signal: (req as unknown as { signal?: AbortSignal }).signal,
        onBatchStart: (i, total, size) => {
          lastTotal = total;
          lastSize = size;
          write("batch-start", { i, total, size });
        },
        onBatchDone: (i, total, matches) => {
          allMatches.push(...matches);
          write("batch-done", {
            i,
            total,
            matches,                          // full ItemMatch[] — see header comment
            accumulated: allMatches.length,
          });
        },
        onBatchTimeout: (i, total, timeoutMs, consecutiveTimeouts) => {
          write("batch-timeout", {
            i,
            total,
            timeoutMs,
            consecutiveTimeouts,
          });
        },
      },
    );

    partial = result.partial ?? false;
    failedBatches = result.failedBatches;

    const model =
      body.model ?? process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3";
    write("done", {
      model,
      batches: lastTotal,
      items: lastSize,
      matches: result.matches,
      partial,
      ...(failedBatches ? { failedBatches } : {}),
    });
  } catch (err) {
    const isAbort =
      (err as { name?: string })?.name === "AbortError" ||
      (err instanceof Error && err.message.toLowerCase().includes("aborted"));
    if (isAbort) {
      console.warn("[categorize] client disconnected, aborting");
      // Client is already gone — no need to write an error event.
    } else {
      console.error("[categorize] failed:", err);
      write("error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearInterval(heartbeat);
    // Defer end() so the error event above has time to flush over the
    // wire before the connection closes. Without this, the extension
    // can see `batch-start` arrive and then hang waiting for batch-done
    // that already fired into a discarded buffer.
    setImmediate(() => {
      if (!res.writableEnded) res.end();
    });
  }
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[express] error:", err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`[hatali-proxy] listening on http://localhost:${PORT}`);
  console.log(
    `[hatali-proxy] base URL: ${process.env.ANTHROPIC_BASE_URL ?? "(default Anthropic)"}`,
  );
  console.log(`[hatali-proxy] default model: ${process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3"}`);
  console.log(`[hatali-proxy] allowed origins: ${allowed.join(", ") || "(none)"}`);
});