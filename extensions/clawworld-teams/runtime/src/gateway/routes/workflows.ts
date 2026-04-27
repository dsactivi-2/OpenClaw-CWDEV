/**
 * OpenClaw Teams — /api/workflows Router
 *
 * POST /              — start a new workflow
 * GET  /              — list workflows (paginated)
 * GET  /:id           — get workflow status
 * GET  /:id/graph     — get workflow Mermaid diagram
 * DELETE /:id         — cancel workflow
 */

import { Router, type Request, type Response } from "express";
import Joi from "joi";
import type { GraphMemoryManager } from "../../memory/graph-memory.js";
import type { LangGraphOrchestrator } from "../../orchestrator/langgraph-orchestrator.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("WorkflowsRouter");

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const startWorkflowSchema = Joi.object({
  userInput: Joi.string().min(1).max(32_000).required(),
  stateKey: Joi.string().min(1).max(256).optional(),
}).options({ allowUnknown: false });

const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

interface ApiError {
  error: string;
  details?: unknown;
  requestId?: string;
}

function errorBody(message: string, details?: unknown, reqId?: string): ApiError {
  return {
    error: message,
    ...(details ? { details } : {}),
    ...(reqId ? { requestId: reqId } : {}),
  };
}

function requestId(req: Request): string {
  return (req.headers["x-request-id"] as string | undefined) ?? "";
}

function wrapAsync(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    void handler(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Unhandled workflow router error", { message });
      if (!res.headersSent) {
        res.status(500).json(errorBody("Internal server error", message, requestId(req)));
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface WorkflowRouterDeps {
  orchestrator: LangGraphOrchestrator;
  memoryManager: GraphMemoryManager;
}

export function createWorkflowRouter(deps: WorkflowRouterDeps): Router {
  const router = Router();
  const { orchestrator, memoryManager } = deps;

  // -------------------------------------------------------------------------
  // POST / — start workflow
  // -------------------------------------------------------------------------
  router.post(
    "/",
    wrapAsync(async (req: Request, res: Response) => {
      const reqId = requestId(req);

      const { error, value } = startWorkflowSchema.validate(req.body);
      if (error) {
        return res.status(400).json(errorBody("Validation failed", error.details, reqId));
      }

      const { userInput, stateKey } = value as { userInput: string; stateKey?: string };
      const runKey = stateKey ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      log.info("Starting workflow", { runKey, inputLength: userInput.length, reqId });

      // Fire-and-forget — respond 202 immediately; client polls GET /:id for updates
      setImmediate(async () => {
        try {
          const finalState = await orchestrator.execute(userInput, runKey);
          await memoryManager.saveStateWithHistory(runKey, finalState);
          log.info("Workflow completed in background", {
            runKey,
            deploymentReady: finalState.deploymentReady,
            errorCount: finalState.errors.length,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("Workflow failed in background", { runKey, message });
        }
      });

      return res.status(202).json({
        id: runKey,
        status: "running",
        message: "Workflow started. Poll GET /api/workflows/:id for status.",
        requestId: reqId,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // GET / — list workflows (paginated)
  // -------------------------------------------------------------------------
  router.get(
    "/",
    wrapAsync(async (req: Request, res: Response) => {
      const reqId = requestId(req);

      const { error, value } = listQuerySchema.validate(req.query);
      if (error) {
        return res.status(400).json(errorBody("Invalid query parameters", error.details, reqId));
      }

      const { page, pageSize } = value as { page: number; pageSize: number };

      try {
        const result = await memoryManager.listAllStates(page, pageSize);
        return res.status(200).json({
          items: result.items,
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          requestId: reqId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Failed to list workflows", { message, reqId });
        return res.status(500).json(errorBody("Failed to list workflows", message, reqId));
      }
    }),
  );

  // -------------------------------------------------------------------------
  // GET /:id — get workflow status
  // -------------------------------------------------------------------------
  router.get(
    "/:id",
    wrapAsync(async (req: Request, res: Response) => {
      const reqId = requestId(req);
      const { id } = req.params as { id: string };

      // Guard against path traversal
      if (id.includes("..") || id.includes("/") || id.includes("\\")) {
        return res.status(400).json(errorBody("Invalid workflow id", undefined, reqId));
      }

      try {
        // Check in-memory orchestrator first
        const liveStatus = orchestrator.getStatus(id);
        if (liveStatus) {
          return res.status(200).json({ id, ...liveStatus, requestId: reqId });
        }

        // Fall back to persistent store
        const state = await memoryManager.loadState(id);
        if (!state) {
          return res.status(404).json(errorBody("Workflow not found", undefined, reqId));
        }

        return res.status(200).json({
          id,
          currentStep: state.currentStep,
          stepHistory: state.stepHistory,
          deploymentReady: state.deploymentReady,
          errorCount: state.errors.length,
          startTime: state.startTime,
          endTime: state.endTime,
          decisions: state.decisions,
          requestId: reqId,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Failed to get workflow status", { id, message, reqId });
        return res.status(500).json(errorBody("Failed to retrieve workflow", message, reqId));
      }
    }),
  );

  // -------------------------------------------------------------------------
  // GET /:id/graph — mermaid diagram
  // -------------------------------------------------------------------------
  router.get(
    "/:id/graph",
    wrapAsync(async (req: Request, res: Response) => {
      const reqId = requestId(req);
      const { id } = req.params as { id: string };

      if (id.includes("..") || id.includes("/") || id.includes("\\")) {
        return res.status(400).json(errorBody("Invalid workflow id", undefined, reqId));
      }

      try {
        const state = await memoryManager.loadState(id);
        if (!state) {
          return res.status(404).json(errorBody("Workflow not found", undefined, reqId));
        }

        const diagram = await memoryManager.exportAsMermaidDiagram(id);
        return res.status(200).json({ id, diagram, requestId: reqId });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Failed to generate graph diagram", { id, message, reqId });
        return res.status(500).json(errorBody("Failed to generate diagram", message, reqId));
      }
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /:id — cancel workflow
  // -------------------------------------------------------------------------
  router.delete(
    "/:id",
    wrapAsync(async (req: Request, res: Response) => {
      const reqId = requestId(req);
      const { id } = req.params as { id: string };

      if (id.includes("..") || id.includes("/") || id.includes("\\")) {
        return res.status(400).json(errorBody("Invalid workflow id", undefined, reqId));
      }

      try {
        const state = await memoryManager.loadState(id);
        if (!state) {
          // Also check live state store
          const live = orchestrator.getStatus(id);
          if (!live) {
            return res.status(404).json(errorBody("Workflow not found", undefined, reqId));
          }
        }

        // The orchestrator's internal store does not expose cancellation directly —
        // record the cancellation intent in a persisted state marker.
        const currentState = await memoryManager.loadState(id);
        if (currentState && !currentState.endTime) {
          const cancelledState = {
            ...currentState,
            endTime: new Date().toISOString(),
            errors: [
              ...currentState.errors,
              {
                step: "cancelled",
                timestamp: new Date().toISOString(),
                message: "Workflow cancelled by API request",
                retryable: false,
              },
            ],
          };
          await memoryManager.saveStateWithHistory(id, cancelledState);
        }

        log.info("Workflow cancelled", { id, reqId });
        return res.status(200).json({ id, status: "cancelled", requestId: reqId });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Failed to cancel workflow", { id, message, reqId });
        return res.status(500).json(errorBody("Failed to cancel workflow", message, reqId));
      }
    }),
  );

  return router;
}
