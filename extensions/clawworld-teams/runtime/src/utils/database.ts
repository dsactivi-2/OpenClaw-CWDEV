/**
 * OpenClaw Teams — PostgreSQL Pool Utility
 * Singleton pool, generic query wrapper, transaction helper and health-check.
 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { createLogger } from "./logger.js";

const log = createLogger("Database");

// ---------------------------------------------------------------------------
// Singleton Pool
// ---------------------------------------------------------------------------

let pool: Pool | null = null;

type PoolConfig = ConstructorParameters<typeof Pool>[0] & { max?: number };

let _poolConfig: PoolConfig | null = null;

function parseOptionalBool(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalised = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalised)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalised)) {
    return false;
  }
  throw new Error(`Invalid boolean value "${value}"`);
}

function buildConnectionConfig(): PoolConfig {
  if (_poolConfig) {
    return _poolConfig;
  }

  const url = process.env["DATABASE_URL"];
  const isProduction = process.env["NODE_ENV"] === "production";
  const poolMax = parseInt(process.env["DB_POOL_MAX"] ?? "20", 10);
  const sslEnabled = parseOptionalBool(process.env["DB_SSL"]) ?? isProduction;
  const sslRejectUnauthorized =
    parseOptionalBool(process.env["DB_SSL_REJECT_UNAUTHORIZED"]) ?? true;

  if (url) {
    _poolConfig = {
      connectionString: url,
      max: poolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: sslEnabled ? { rejectUnauthorized: sslRejectUnauthorized } : false,
    };
    return _poolConfig;
  }

  const password = process.env["DB_PASSWORD"];
  if (!password) {
    throw new Error("DB_PASSWORD environment variable is required (or set DATABASE_URL)");
  }

  _poolConfig = {
    host: process.env["DB_HOST"] ?? "localhost",
    port: parseInt(process.env["DB_PORT"] ?? "5432", 10),
    database: process.env["DB_NAME"] ?? "openclaw_teams",
    user: process.env["DB_USER"] ?? "openclaw",
    password,
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: sslEnabled ? { rejectUnauthorized: sslRejectUnauthorized } : false,
  };
  return _poolConfig;
}

/**
 * Returns (and lazily creates) the singleton PostgreSQL connection pool.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool(buildConnectionConfig());

    pool.on("connect", (client) => {
      log.debug("New database connection established", {
        processId: (client as unknown as { processID?: number }).processID,
      });
    });

    pool.on("error", (err) => {
      log.error("Unexpected error on idle database client", {
        message: err.message,
        stack: err.stack,
      });
    });

    pool.on("remove", () => {
      log.debug("Database connection removed from pool");
    });

    const cfg = buildConnectionConfig();
    log.info("PostgreSQL connection pool initialised", {
      max: cfg.max ?? 20,
      host: process.env["DB_HOST"] ?? "localhost",
      database: process.env["DB_NAME"] ?? "openclaw_teams",
    });
  }

  return pool;
}

// ---------------------------------------------------------------------------
// Generic Query Wrapper
// ---------------------------------------------------------------------------

/**
 * Executes a parameterised SQL query and returns the full QueryResult.
 *
 * @example
 * const result = await query<{ id: string }>(
 *   'SELECT id FROM users WHERE email = $1',
 *   ['alice@example.com']
 * );
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await getPool().query<T>(sql, params);
    const duration = Date.now() - start;
    log.debug("Query executed", {
      sql: sql.slice(0, 120),
      rowCount: result.rowCount,
      durationMs: duration,
    });
    return result;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("Query failed", {
      sql: sql.slice(0, 120),
      params: params.map((p) => (typeof p === "string" ? p.slice(0, 40) : p)),
      message: error.message,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Transaction Helper
// ---------------------------------------------------------------------------

/**
 * Runs `callback` inside a BEGIN/COMMIT block.
 * Automatically rolls back on any error and re-throws.
 *
 * @example
 * const result = await transaction(async (client) => {
 *   await client.query('INSERT INTO ...');
 *   return await client.query('SELECT ...');
 * });
 */
export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    log.debug("Transaction started");

    const result = await callback(client);

    await client.query("COMMIT");
    log.debug("Transaction committed");
    return result;
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    try {
      await client.query("ROLLBACK");
      log.warn("Transaction rolled back", { message: error.message });
    } catch (rollbackErr: unknown) {
      const rbError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      log.error("ROLLBACK failed", { message: rbError.message });
    }
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

export interface DatabaseHealth {
  status: "healthy" | "unhealthy";
  message: string;
  latencyMs: number;
  totalConnections: number;
  idleConnections: number;
  waitingConnections: number;
}

/**
 * Pings the database and returns a structured health status object.
 */
export async function healthCheck(): Promise<DatabaseHealth> {
  const start = Date.now();
  const currentPool = getPool();

  try {
    await currentPool.query("SELECT 1");
    const latencyMs = Date.now() - start;

    return {
      status: "healthy",
      message: "Database connection is healthy",
      latencyMs,
      totalConnections: currentPool.totalCount,
      idleConnections: currentPool.idleCount,
      waitingConnections: currentPool.waitingCount,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    const latencyMs = Date.now() - start;

    log.error("Database health check failed", { message: error.message });

    return {
      status: "unhealthy",
      message: error.message,
      latencyMs,
      totalConnections: currentPool.totalCount,
      idleConnections: currentPool.idleCount,
      waitingConnections: currentPool.waitingCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Pool Shutdown
// ---------------------------------------------------------------------------

/**
 * Gracefully drains and closes the singleton pool.
 * Should be called during application shutdown.
 */
export async function closePool(): Promise<void> {
  if (pool) {
    log.info("Closing database pool…");
    await pool.end();
    pool = null;
    // Reset the cached config so the next getPool() re-reads env vars fresh.
    // This matters in test environments where DB config may change between
    // pool close and the next test suite's pool creation.
    _poolConfig = null;
    log.info("Database pool closed");
  }
}
