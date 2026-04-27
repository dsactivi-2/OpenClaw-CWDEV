/**
 * OpenClaw Teams — Graph Memory Manager
 * Persists LangGraph workflow state, edges and checkpoints to PostgreSQL.
 * Provides cache-first reads and Mermaid diagram export.
 */

import type { Pool } from "pg";
import type { GraphState } from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("GraphMemoryManager");

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface StateRow {
  state_key: string;
  state: GraphState;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: number;
  state_key: string;
  from_node: string | null;
  to_node: string | null;
  created_at: string;
}

interface CheckpointRow {
  id: number;
  state_key: string;
  state: GraphState;
  node_name: string;
  created_at: string;
}

interface StateListItem {
  stateKey: string;
  currentStep: string;
  deploymentReady: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedStates {
  items: StateListItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// GraphMemoryManager
// ---------------------------------------------------------------------------

export class GraphMemoryManager {
  private readonly pool: Pool;

  /**
   * In-memory state cache (stateKey -> GraphState).
   * Used to avoid redundant DB reads within the same process lifecycle.
   */
  private readonly cache = new Map<string, GraphState>();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // -------------------------------------------------------------------------
  // Schema Initialisation
  // -------------------------------------------------------------------------

  /**
   * Creates all 4 LangGraph tables if they do not already exist.
   * Safe to call multiple times (idempotent).
   */
  async initialize(): Promise<void> {
    log.info("Initialising LangGraph database schema…");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Main state store
      await client.query(`
        CREATE TABLE IF NOT EXISTS langgraph_states (
          state_key   TEXT        PRIMARY KEY,
          state       JSONB       NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // 2. Edge / transition log
      await client.query(`
        CREATE TABLE IF NOT EXISTS langgraph_edges (
          id          BIGSERIAL   PRIMARY KEY,
          state_key   TEXT        NOT NULL REFERENCES langgraph_states(state_key) ON DELETE CASCADE,
          from_node   TEXT,
          to_node     TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // 3. Checkpoint snapshots (one per node completion)
      await client.query(`
        CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
          id          BIGSERIAL   PRIMARY KEY,
          state_key   TEXT        NOT NULL REFERENCES langgraph_states(state_key) ON DELETE CASCADE,
          node_name   TEXT        NOT NULL,
          state       JSONB       NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // 4. Step history log (lightweight append-only)
      await client.query(`
        CREATE TABLE IF NOT EXISTS langgraph_step_history (
          id          BIGSERIAL   PRIMARY KEY,
          state_key   TEXT        NOT NULL REFERENCES langgraph_states(state_key) ON DELETE CASCADE,
          step_name   TEXT        NOT NULL,
          logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Indexes
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_langgraph_edges_state_key
          ON langgraph_edges(state_key)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_langgraph_checkpoints_state_key
          ON langgraph_checkpoints(state_key)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_langgraph_step_history_state_key
          ON langgraph_step_history(state_key)
      `);

      await client.query("COMMIT");
      log.info("LangGraph schema ready");
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Schema initialisation failed", { message: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // State Persistence
  // -------------------------------------------------------------------------

  /**
   * Persists the full GraphState, records the edge transition and writes
   * a checkpoint — all within a single transaction.
   *
   * @param stateKey  Unique identifier for this workflow run
   * @param state     Full current GraphState
   * @param fromNode  Node we just left (undefined for the first save)
   * @param toNode    Node we are entering (undefined for the final save)
   */
  async saveStateWithHistory(
    stateKey: string,
    state: GraphState,
    fromNode?: string,
    toNode?: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Upsert main state row
      await client.query(
        `
        INSERT INTO langgraph_states (state_key, state, created_at, updated_at)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (state_key) DO UPDATE
          SET state      = EXCLUDED.state,
              updated_at = NOW()
        `,
        [stateKey, JSON.stringify(state)],
      );

      // Record edge transition
      if (fromNode !== undefined || toNode !== undefined) {
        await client.query(
          `
          INSERT INTO langgraph_edges (state_key, from_node, to_node)
          VALUES ($1, $2, $3)
          `,
          [stateKey, fromNode ?? null, toNode ?? null],
        );
      }

      // Write checkpoint snapshot
      const checkpointNode = toNode ?? fromNode ?? state.currentStep ?? "unknown";
      await client.query(
        `
        INSERT INTO langgraph_checkpoints (state_key, node_name, state)
        VALUES ($1, $2, $3)
        `,
        [stateKey, checkpointNode, JSON.stringify(state)],
      );

      await client.query("COMMIT");

      // Update in-memory cache
      this.cache.set(stateKey, state);

      log.debug("State saved with history", {
        stateKey,
        fromNode: fromNode ?? null,
        toNode: toNode ?? null,
        currentStep: state.currentStep,
      });
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to save state with history", {
        stateKey,
        message: error.message,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // State Loading
  // -------------------------------------------------------------------------

  /**
   * Loads the GraphState for a given stateKey.
   * Checks the in-memory cache first; falls back to PostgreSQL.
   * Returns null when no state is found.
   */
  async loadState(stateKey: string): Promise<GraphState | null> {
    // Cache hit
    const cached = this.cache.get(stateKey);
    if (cached !== undefined) {
      log.debug("State loaded from cache", { stateKey });
      return cached;
    }

    // PostgreSQL fallback
    try {
      const result = await this.pool.query<StateRow>(
        "SELECT * FROM langgraph_states WHERE state_key = $1",
        [stateKey],
      );

      if (result.rows.length === 0) {
        log.debug("State not found", { stateKey });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        return null;
      }

      const state = row.state;
      this.cache.set(stateKey, state);

      log.debug("State loaded from database", { stateKey });
      return state;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to load state", { stateKey, message: error.message });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Workflow Graph
  // -------------------------------------------------------------------------

  /**
   * Returns the full ordered list of edge transitions for a given workflow run.
   */
  async getWorkflowGraph(
    stateKey: string,
  ): Promise<Array<{ fromNode: string | null; toNode: string | null; timestamp: string }>> {
    try {
      const result = await this.pool.query<EdgeRow>(
        `
        SELECT from_node, to_node, created_at
        FROM langgraph_edges
        WHERE state_key = $1
        ORDER BY created_at ASC
        `,
        [stateKey],
      );

      return result.rows.map((row) => ({
        fromNode: row.from_node,
        toNode: row.to_node,
        timestamp: row.created_at,
      }));
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to get workflow graph", { stateKey, message: error.message });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Checkpoint Restore
  // -------------------------------------------------------------------------

  /**
   * Restores a GraphState from a specific checkpoint row by its numeric ID.
   * Returns null when the checkpoint does not exist.
   */
  async restoreFromCheckpoint(checkpointId: number): Promise<GraphState | null> {
    try {
      const result = await this.pool.query<CheckpointRow>(
        "SELECT * FROM langgraph_checkpoints WHERE id = $1",
        [checkpointId],
      );

      if (result.rows.length === 0) {
        log.warn("Checkpoint not found", { checkpointId });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        return null;
      }

      const state = row.state;
      log.info("State restored from checkpoint", {
        checkpointId,
        stateKey: row.state_key,
        nodeName: row.node_name,
      });

      // Warm the cache with the restored state
      this.cache.set(row.state_key, state);

      return state;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to restore from checkpoint", {
        checkpointId,
        message: error.message,
      });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // List States (paginated)
  // -------------------------------------------------------------------------

  /**
   * Returns a paginated list of all state keys with summary fields.
   *
   * @param page     1-indexed page number (default: 1)
   * @param pageSize Number of items per page (default: 20)
   */
  async listAllStates(page = 1, pageSize = 20): Promise<PaginatedStates> {
    const offset = (page - 1) * pageSize;

    try {
      const [rowsResult, countResult] = await Promise.all([
        this.pool.query<{
          state_key: string;
          state: GraphState;
          created_at: string;
          updated_at: string;
        }>(
          `
          SELECT state_key, state, created_at, updated_at
          FROM langgraph_states
          ORDER BY updated_at DESC
          LIMIT $1 OFFSET $2
          `,
          [pageSize, offset],
        ),
        this.pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM langgraph_states"),
      ]);

      const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

      const items: StateListItem[] = rowsResult.rows.map((row) => ({
        stateKey: row.state_key,
        currentStep: row.state.currentStep ?? "unknown",
        deploymentReady: row.state.deploymentReady ?? false,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));

      return { items, total, page, pageSize };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to list states", { message: error.message });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Mermaid Diagram Export
  // -------------------------------------------------------------------------

  /**
   * Generates a Mermaid `flowchart LR` diagram string from the stored edges
   * for a given workflow run.
   *
   * @returns Mermaid markup string, or a placeholder when no edges exist.
   */
  async exportAsMermaidDiagram(stateKey: string): Promise<string> {
    const edges = await this.getWorkflowGraph(stateKey);

    if (edges.length === 0) {
      return `flowchart LR\n  START([No edges recorded for ${stateKey}])`;
    }

    const lines: string[] = ["flowchart LR"];
    const nodeSet = new Set<string>();

    for (const edge of edges) {
      const from = edge.fromNode ?? "START";
      const to = edge.toNode ?? "END";

      // Register unique node declarations
      if (!nodeSet.has(from)) {
        lines.push(`  ${this.sanitizeNodeId(from)}["${from}"]`);
        nodeSet.add(from);
      }
      if (!nodeSet.has(to)) {
        lines.push(`  ${this.sanitizeNodeId(to)}["${to}"]`);
        nodeSet.add(to);
      }

      lines.push(`  ${this.sanitizeNodeId(from)} --> ${this.sanitizeNodeId(to)}`);
    }

    return lines.join("\n");
  }

  /** Converts a node name to a valid Mermaid node identifier. */
  private sanitizeNodeId(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Deletes states (and their cascaded rows) that have not been updated
   * within the last `daysOld` days.
   *
   * @returns Number of state rows deleted.
   */
  async cleanupOldStates(daysOld: number): Promise<number> {
    if (daysOld <= 0) {
      throw new Error("daysOld must be a positive integer");
    }

    try {
      const result = await this.pool.query<{ count: string }>(
        `
        WITH deleted AS (
          DELETE FROM langgraph_states
          WHERE updated_at < NOW() - ($1 || ' days')::INTERVAL
          RETURNING state_key
        )
        SELECT COUNT(*) AS count FROM deleted
        `,
        [daysOld],
      );

      const deleted = parseInt(result.rows[0]?.count ?? "0", 10);

      // Evict deleted keys from cache (best effort — keys not tracked here,
      // so clear the full cache to prevent stale reads)
      this.cache.clear();

      log.info("Old states cleaned up", { daysOld, deleted });
      return deleted;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to clean up old states", { message: error.message });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  /**
   * Ends the PostgreSQL pool. Call during graceful shutdown.
   */
  async close(): Promise<void> {
    log.info("Closing GraphMemoryManager pool…");
    await this.pool.end();
    this.cache.clear();
    log.info("GraphMemoryManager pool closed");
  }
}
