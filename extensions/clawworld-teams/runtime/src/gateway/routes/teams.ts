/**
 * OpenClaw Teams — /api/teams Router
 *
 * POST /spawn     — spawn a new team
 * GET  /          — list active teams
 * GET  /:id       — team status and health
 * DELETE /:id     — despawn team
 * POST /:id/scale — scale team up or down
 */

import { Router, type Request, type Response } from "express";
import Joi from "joi";
import type { TeamSpawningSkill, SpawnTeamConfig } from "../../../skills/team_spawning.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("TeamsRouter");

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const agentConfigSchema = Joi.object({
  id: Joi.string().optional(),
  name: Joi.string().min(1).max(128).required(),
  model: Joi.string().min(1).required(),
  systemPrompt: Joi.string().min(1).required(),
  maxTokens: Joi.number().integer().min(1).default(4096),
  temperature: Joi.number().min(0).max(1).default(0.7),
  tools: Joi.array().items(Joi.string()).default([]),
  metadata: Joi.object().unknown(true).default({}),
});

const spawnTeamSchema = Joi.object({
  name: Joi.string().min(1).max(256).required(),
  role: Joi.string().min(1).max(512).required(),
  agents: Joi.array().items(agentConfigSchema).min(1).required(),
  maxConcurrency: Joi.number().integer().min(1).default(5),
  timeoutMs: Joi.number().integer().min(0).default(300_000),
  metadata: Joi.object().unknown(true).default({}),
}).options({ allowUnknown: false });

const scaleTeamSchema = Joi.object({
  targetCount: Joi.number().integer().min(0).required(),
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

function errorStatus(err: Error): number {
  switch (err.name) {
    case "TeamNotFoundError":
      return 404;
    case "TeamSpawningValidationError":
      return 400;
    case "TeamScalingError":
      return 409;
    default:
      return 500;
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export interface TeamsRouterDeps {
  teamSkill: TeamSpawningSkill;
}

export function createTeamsRouter(deps: TeamsRouterDeps): Router {
  const router = Router();
  const { teamSkill } = deps;

  // -------------------------------------------------------------------------
  // POST /spawn — spawn a new team
  // -------------------------------------------------------------------------
  router.post("/spawn", (req: Request, res: Response) => {
    const reqId = rid(req);

    const { error, value } = spawnTeamSchema.validate(req.body);
    if (error) {
      return res.status(400).json(errorBody("Validation failed", error.details, reqId));
    }

    try {
      const config = value as SpawnTeamConfig;
      const team = teamSkill.spawnTeam(config);

      log.info("Team spawned via API", {
        teamId: team.teamId,
        name: team.name,
        agentCount: team.agents.length,
        reqId,
      });

      return res.status(201).json({
        teamId: team.teamId,
        name: team.name,
        status: team.status,
        agentCount: team.agents.length,
        agents: team.agents.map((a) => ({
          agentId: a.agentId,
          name: a.config.name,
          model: a.config.model,
          status: a.status,
        })),
        createdAt: team.createdAt,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to spawn team", { message: e.message, reqId });
      return res.status(errorStatus(e)).json(errorBody(e.message, undefined, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // GET / — list active teams
  // -------------------------------------------------------------------------
  router.get("/", (_req: Request, res: Response) => {
    const reqId = rid(_req);
    try {
      const teams = teamSkill.listTeams();
      return res.status(200).json({
        teams: teams.map((t) => ({
          teamId: t.teamId,
          name: t.name,
          status: t.status,
          agentCount: t.agents.length,
          activeTaskCount: t.activeTaskCount,
          totalTokensUsed: t.totalTokensUsed,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
        total: teams.length,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to list teams", { message, reqId });
      return res.status(500).json(errorBody("Failed to list teams", message, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // GET /:id — team status and health
  // -------------------------------------------------------------------------
  router.get("/:id", (req: Request, res: Response) => {
    const reqId = rid(req);
    const { id } = req.params as { id: string };

    if (!isPathSafe(id)) {
      return res.status(400).json(errorBody("Invalid team id", undefined, reqId));
    }

    try {
      const health = teamSkill.getTeamStatus(id);

      return res.status(200).json({
        teamId: health.teamId,
        name: health.name,
        status: health.status,
        agents: health.agents.map((a) => ({
          agentId: a.agentId,
          name: a.config.name,
          model: a.config.model,
          status: a.status,
          spawnedAt: a.spawnedAt,
          resources: a.resources,
        })),
        totalTokensUsed: health.totalTokensUsed,
        totalEstimatedCostUsd: health.totalEstimatedCostUsd,
        activeTaskCount: health.activeTaskCount,
        createdAt: health.createdAt,
        updatedAt: health.updatedAt,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to get team status", { id, message: e.message, reqId });
      return res.status(errorStatus(e)).json(errorBody(e.message, undefined, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /:id — despawn team
  // -------------------------------------------------------------------------
  router.delete("/:id", (req: Request, res: Response) => {
    const reqId = rid(req);
    const { id } = req.params as { id: string };

    if (!isPathSafe(id)) {
      return res.status(400).json(errorBody("Invalid team id", undefined, reqId));
    }

    try {
      // Verify existence first
      const team = teamSkill.getTeamStatus(id);

      // Despawn all agents in the team
      const agentIds = team.agents.map((a) => a.agentId);
      for (const agentId of agentIds) {
        try {
          teamSkill.despawnAgent(agentId);
        } catch {
          // Agent may have already been removed
        }
      }

      log.info("Team despawned", { teamId: id, agentCount: agentIds.length, reqId });

      return res.status(200).json({
        teamId: id,
        status: "dissolved",
        despawnedAgents: agentIds.length,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to despawn team", { id, message: e.message, reqId });
      return res.status(errorStatus(e)).json(errorBody(e.message, undefined, reqId));
    }
  });

  // -------------------------------------------------------------------------
  // POST /:id/scale — scale team
  // -------------------------------------------------------------------------
  router.post("/:id/scale", (req: Request, res: Response) => {
    const reqId = rid(req);
    const { id } = req.params as { id: string };

    if (!isPathSafe(id)) {
      return res.status(400).json(errorBody("Invalid team id", undefined, reqId));
    }

    const { error, value } = scaleTeamSchema.validate(req.body);
    if (error) {
      return res.status(400).json(errorBody("Validation failed", error.details, reqId));
    }

    const { targetCount } = value as { targetCount: number };

    try {
      const scaled = teamSkill.scaleTeam(id, targetCount);

      log.info("Team scaled via API", {
        teamId: id,
        targetCount,
        actual: scaled.agents.length,
        reqId,
      });

      return res.status(200).json({
        teamId: scaled.teamId,
        name: scaled.name,
        status: scaled.status,
        agentCount: scaled.agents.length,
        agents: scaled.agents.map((a) => ({
          agentId: a.agentId,
          name: a.config.name,
          status: a.status,
        })),
        updatedAt: scaled.updatedAt,
        requestId: reqId,
      });
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      log.error("Failed to scale team", { id, targetCount, message: e.message, reqId });
      return res.status(errorStatus(e)).json(errorBody(e.message, undefined, reqId));
    }
  });

  return router;
}
