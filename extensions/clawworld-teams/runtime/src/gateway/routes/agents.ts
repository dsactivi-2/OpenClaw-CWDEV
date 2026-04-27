/**
 * OpenClaw Teams — /api/agents Router
 *
 * GET  /              — list all agents with status
 * GET  /:id           — get agent details
 * POST /:id/task      — assign task to agent
 * GET  /:id/metrics   — agent performance metrics
 */

import { Router, type Request, type Response } from "express";
import Joi from "joi";
import type { TeamSpawningSkill } from "../../../skills/team_spawning.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AgentsRouter");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const assignTaskSchema = Joi.object({
  task: Joi.alternatives()
    .try(Joi.string().min(1).max(32_000), Joi.object().unknown(true))
    .required(),
  metadata: Joi.object().unknown(true).optional(),
}).options({ allowUnknown: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApiError {
  error: string;
  details?: unknown;
  requestId?: string;
}

function errorBody(message: string, details?: unknown, requestId?: string): ApiError {
  return { error: message, ...(details ? { details } : {}), ...(requestId ? { requestId } : {}) };
}

function rid(req: Request): string {
  return (req.headers["x-request-id"] as string | undefined) ?? "";
}

function isPathSafe(id: string): boolean {
  return !id.includes("..") && !id.includes("/") && !id.includes("\\");
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface AgentsRouterDeps {
  teamSkill: TeamSpawningSkill;
}

export function createAgentsRouter(deps: AgentsRouterDeps): Router {
  const router = Router();
  const { teamSkill } = deps;

  // -------------------------------------------------------------------------
  // GET / — list all agents
  // -------------------------------------------------------------------------
  router.get("/", (_req: Request, res: Response) => {
    const reqId = rid(_req);
    try {
      const teams = teamSkill.listTeams();
      const agents = teams.flatMap((team) =>
        team.agents.map((agent) => ({
          agentId: agent.agentId,
          name: agent.config.name,
          model: agent.config.model,
          teamId: agent.teamId,
          status: agent.status,
          spawnedAt: agent.spawnedAt,
          resources: agent.resources,
        })),
      );

      return res.status(200).json({ agents, total: agents.length, requestId: reqId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to list agents", { message, reqId });
      return res.status(500).json(errorBody("Failed to list agents", message, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id — agent details
  // -------------------------------------------------------------------------
  router.get("/:id", (req: Request, res: Response) => {
    const reqId = rid(req);
    const { id } = req.params as { id: string };

    if (!isPathSafe(id)) {
      return res.status(400).json(errorBody("Invalid agent id", undefined, reqId));
    }

    try {
      const teams = teamSkill.listTeams();
      let found: (typeof teams)[number]["agents"][number] | undefined;
      for (const team of teams) {
        const agent = team.agents.find((a) => a.agentId === id);
        if (agent) {
          found = agent;
          break;
        }
      }

      if (!found) {
        return res.status(404).json(errorBody("Agent not found", undefined, reqId));
      }

      return res.status(200).json({
        agentId: found.agentId,
        name: found.config.name,
        model: found.config.model,
        teamId: found.teamId,
        status: found.status,
        systemPrompt: found.config.systemPrompt,
        maxTokens: found.config.maxTokens,
        temperature: found.config.temperature,
        tools: found.config.tools,
        metadata: found.config.metadata,
        spawnedAt: found.spawnedAt,
        updatedAt: found.updatedAt,
        resources: found.resources,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to get agent", { id, message, reqId });
      return res.status(500).json(errorBody("Failed to retrieve agent", message, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // POST /:id/task — assign task to agent
  // -------------------------------------------------------------------------
  router.post("/:id/task", (req: Request, res: Response) => {
    const reqId = rid(req);
    const { id } = req.params as { id: string };

    if (!isPathSafe(id)) {
      return res.status(400).json(errorBody("Invalid agent id", undefined, reqId));
    }

    const { error, value } = assignTaskSchema.validate(req.body);
    if (error) {
      return res.status(400).json(errorBody("Validation failed", error.details, reqId));
    }

    try {
      // Find the agent and its team
      const teams = teamSkill.listTeams();
      let teamId: string | undefined;
      let agentFound = false;

      for (const team of teams) {
        const agent = team.agents.find((a) => a.agentId === id);
        if (agent) {
          teamId = team.teamId;
          agentFound = true;
          break;
        }
      }

      if (!agentFound || !teamId) {
        return res.status(404).json(errorBody("Agent not found", undefined, reqId));
      }

      const taskPayload = { agentId: id, ...(value as { task: unknown; metadata?: unknown }) };
      const teamTask = teamSkill.assignTaskToTeam(teamId, taskPayload);

      log.info("Task assigned to agent", { agentId: id, teamId, taskId: teamTask.taskId, reqId });

      return res.status(201).json({
        taskId: teamTask.taskId,
        agentId: id,
        teamId,
        status: teamTask.status,
        createdAt: teamTask.createdAt,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof Error && err.name === "TeamScalingError" ? 409 : 500;
      log.error("Failed to assign task to agent", { id, message, reqId });
      return res.status(status).json(errorBody("Failed to assign task", message, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id/metrics — agent performance metrics
  // -------------------------------------------------------------------------
  router.get("/:id/metrics", (req: Request, res: Response) => {
    const reqId = rid(req);
    const { id } = req.params as { id: string };

    if (!isPathSafe(id)) {
      return res.status(400).json(errorBody("Invalid agent id", undefined, reqId));
    }

    try {
      const teams = teamSkill.listTeams();
      let found: (typeof teams)[number]["agents"][number] | undefined;
      for (const team of teams) {
        const agent = team.agents.find((a) => a.agentId === id);
        if (agent) {
          found = agent;
          break;
        }
      }

      if (!found) {
        return res.status(404).json(errorBody("Agent not found", undefined, reqId));
      }

      return res.status(200).json({
        agentId: id,
        name: found.config.name,
        model: found.config.model,
        status: found.status,
        metrics: {
          tokensUsed: found.resources.tokensUsed,
          estimatedCostUsd: found.resources.estimatedCostUsd,
          memoryMb: found.resources.memoryMb,
          tasksCompleted: found.resources.tasksCompleted,
          tasksInProgress: found.resources.tasksInProgress,
          lastActivityAt: found.resources.lastActivityAt,
        },
        spawnedAt: found.spawnedAt,
        updatedAt: found.updatedAt,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to get agent metrics", { id, message, reqId });
      return res.status(500).json(errorBody("Failed to retrieve agent metrics", message, reqId));
    }
  });

  return router;
}
