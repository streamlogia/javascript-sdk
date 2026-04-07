/**
 * Example Express app using the Log Ingestor SDK.
 *
 * Install deps:  npm install express winston winston-transport
 * Run:           LOGINGESTOR_TOKEN=... LOGINGESTOR_PROJECT_ID=... node express-app.js
 */

import express from "express";
import winston from "winston";
import Transport from "winston-transport";
import { LogIngestorClient } from "../logingestor.js";

// ── 1. Create the client ─────────────────────────────────────────────────────
const logs = new LogIngestorClient({
  baseURL: "https://api.streamlogia.com",
  token: process.env.LOGINGESTOR_TOKEN,
  projectId: process.env.LOGINGESTOR_PROJECT_ID,
  source: "payment-service",
});

// ── 2. Set up the logger ─────────────────────────────────────────────────────
// createWinstonTransport mirrors NewSlogHandler from the Go SDK — it adapts
// the ingestor client to Winston so you use one logger everywhere.
//
// Adding winston.transports.Console alongside it mirrors MultiHandler in Go:
// logs go to both stdout (captured by systemd / journalctl) AND the ingestor.
const LogTransport = logs.createWinstonTransport(Transport);
const logger = winston.createLogger({
  level: "debug",
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
    new LogTransport(),
  ],
});

// Flush on shutdown — important so buffered logs aren't lost.
process.on("SIGTERM", async () => {
  await logs.close();
  process.exit(0);
});

// ── 3. Mount the middleware once at the top ───────────────────────────────────
const app = express();
app.use(express.json());

// Every request → one log entry with method, path, status, duration, and
// response size. No per-route code needed.
app.use(logs.expressMiddleware());

// ── 4. Route handlers — use the winston logger for business events ────────────
app.post("/payments", async (req, res) => {
  const { customerId, amount, currency } = req.body;

  try {
    // Simulate payment processing...
    const paymentId = `pay_${Math.random().toString(36).slice(2)}`;

    // Business event: use the winston logger so the entry goes to both stdout
    // and the ingestor (mirrors MultiHandler usage in the Go SDK examples).
    logger.info("payment processed", {
      paymentId,
      amount,
      currency,
      customerId,
    });

    res.status(201).json({ paymentId });
  } catch (err) {
    logger.error("payment failed", { customerId, error: err.message });
    res.status(500).json({ error: "payment failed" });
  }
});

app.get("/payments/:id", async (req, res) => {
  const { id } = req.params;
  // The middleware already logs GET /payments/:id — no manual log needed unless
  // you want to add business context.
  res.json({ id, status: "completed" });
});

app.listen(3000, () => {
  logger.info("server started", { port: 3000 });
});
