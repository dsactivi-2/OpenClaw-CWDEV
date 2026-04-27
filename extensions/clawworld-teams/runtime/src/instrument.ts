/**
 * Sentry instrumentation — MUST be imported before anything else in index.ts
 * No-ops gracefully when SENTRY_DSN is not set (local dev without Sentry).
 */

import * as Sentry from "@sentry/node";

const dsn = process.env["SENTRY_DSN"];

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env["NODE_ENV"] ?? "development",
    ...(process.env["npm_package_version"] !== undefined
      ? { release: process.env["npm_package_version"] }
      : {}),

    // Privacy: do not collect IPs or user PII automatically
    sendDefaultPii: false,

    // Trace 10% of requests in production, 100% locally
    tracesSampleRate: process.env["NODE_ENV"] === "production" ? 0.1 : 1.0,

    // Profile 10% of sampled transactions
    profilesSampleRate: 0.1,
  });
}
