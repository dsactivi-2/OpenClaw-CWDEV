/**
 * OpenClaw Teams — Winston Logger
 * Structured JSON logging for production, coloured console output for dev.
 */

import path from "path";
import winston from "winston";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogContext {
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { combine, timestamp, json, colorize, printf, errors } = winston.format;

const LOG_LEVEL = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const IS_PRODUCTION = NODE_ENV === "production";

// Pretty format used only in development consoles
const DEV_FORMAT = combine(
  colorize({ all: true }),
  timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? `\n  ${JSON.stringify(meta, null, 2)}` : "";
    const stackStr = typeof stack === "string" ? `\n${stack}` : "";
    return `[${String(ts)}] ${level}: ${String(message)}${metaStr}${stackStr}`;
  }),
);

// Structured JSON format used in production and in file transports
const PROD_FORMAT = combine(
  timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
  errors({ stack: true }),
  json(),
);

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const transports: winston.transport[] = [];

// Console transport — coloured in dev, JSON in prod
transports.push(
  new winston.transports.Console({
    format: IS_PRODUCTION ? PROD_FORMAT : DEV_FORMAT,
    handleExceptions: true,
    handleRejections: true,
  }),
);

// File transports — always write JSON regardless of environment
const logsDir = path.resolve(process.cwd(), "logs");

transports.push(
  new winston.transports.File({
    filename: path.join(logsDir, "app.log"),
    format: PROD_FORMAT,
    maxsize: 20 * 1024 * 1024, // 20 MB
    maxFiles: 14,
    tailable: true,
    handleExceptions: false,
  }),
);

transports.push(
  new winston.transports.File({
    filename: path.join(logsDir, "error.log"),
    level: "error",
    format: PROD_FORMAT,
    maxsize: 20 * 1024 * 1024,
    maxFiles: 14,
    tailable: true,
    handleExceptions: true,
    handleRejections: true,
  }),
);

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------

const logger = winston.createLogger({
  level: LOG_LEVEL,
  levels: winston.config.npm.levels, // error, warn, info, http, verbose, debug, silly
  transports,
  exitOnError: false,
});

// ---------------------------------------------------------------------------
// Contextual logger factory
// ---------------------------------------------------------------------------

/**
 * Returns a child logger with extra metadata merged into every log entry.
 *
 * @example
 * const log = withContext({ requestId: req.id, userId: '123' });
 * log.info('Processing request');
 */
export function withContext(context: LogContext): winston.Logger {
  return logger.child(context);
}

/**
 * Returns a child logger scoped to a specific named module or component.
 *
 * @example
 * const log = createLogger('LangGraphOrchestrator');
 * log.debug('Initialising graph');
 */
export function createLogger(component: string, extra?: LogContext): winston.Logger {
  return logger.child({ component, ...extra });
}

// ---------------------------------------------------------------------------
// Convenience re-exports
// ---------------------------------------------------------------------------

export { logger };
export default logger;
