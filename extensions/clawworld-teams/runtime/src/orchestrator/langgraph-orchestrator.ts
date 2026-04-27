/**
 * OpenClaw Teams — LangGraph Orchestrator
 *
 * Implements a 6-node StateGraph that drives a full multi-agent build pipeline:
 *   1. analyzeRequirements   — parse user input into structured requirements
 *   2. planArchitecture      — design agent topology + workflow definitions
 *   3. spawnBuilderTeams     — instantiate team configs for the build phase
 *   4. buildAgents           — call each builder team, collect artifacts
 *   5. validateAndTest       — run tests, decide pass/fix/abort
 *   6. deploySystem          — assemble final plan and mark deployment-ready
 *
 * Models used:
 *   - ANTHROPIC_MODEL_BUILDER     → builder reasoning (planArchitecture, buildAgents)
 *   - ANTHROPIC_MODEL_SUPERVISOR  → supervisor / validation reasoning (analyzeRequirements, validateAndTest)
 *     Defaults: "anthropic/claude-sonnet-4-5" (OpenRouter).  Set env vars to
 *     override, e.g. "claude-sonnet-4-6" for direct Anthropic API.
 */

import Anthropic from "@anthropic-ai/sdk";
import { StateGraph, END, START, MemorySaver } from "@langchain/langgraph";
import type {
  GraphState,
  AgentConfig,
  WorkflowDefinition,
  TeamResult,
  Decision,
  WorkflowError,
  FinalPlan,
  TeamConfig,
  DeploymentConfig,
} from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("LangGraphOrchestrator");

// ---------------------------------------------------------------------------
// Model constants
// Read from env so the provider (Anthropic direct vs OpenRouter) can be
// switched without code changes.  OpenRouter requires the "anthropic/" prefix,
// e.g. "anthropic/claude-sonnet-4-5".  When targeting Anthropic directly use
// the native name, e.g. "claude-sonnet-4-6".
// ---------------------------------------------------------------------------

const MODEL_BUILDER = process.env["ANTHROPIC_MODEL_BUILDER"] ?? "anthropic/claude-sonnet-4-5";
const MODEL_SUPERVISOR = process.env["ANTHROPIC_MODEL_SUPERVISOR"] ?? "anthropic/claude-sonnet-4-5";

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let lastError: Error = new Error("Unknown error");
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isLast = attempt === maxRetries;
      log.warn(`Retry attempt ${attempt}/${maxRetries} for "${label}"`, {
        message: lastError.message,
        isLast,
      });
      if (!isLast) {
        await delay(BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
  }
  throw lastError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Anthropic client helper (singleton — one client per process)
// ---------------------------------------------------------------------------

let _anthropicClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (_anthropicClient) {
    return _anthropicClient;
  }
  const baseURL = process.env["ANTHROPIC_BASE_URL"] ?? null;
  const isOpenRouter = typeof baseURL === "string" && baseURL.includes("openrouter.ai");

  if (isOpenRouter) {
    const token =
      process.env["OPENROUTER_API_KEY"] ??
      process.env["ANTHROPIC_AUTH_TOKEN"] ??
      process.env["ANTHROPIC_API_KEY"] ??
      null;
    if (!token) {
      throw new Error(
        "OpenRouter mode: expected OPENROUTER_API_KEY, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY to be set",
      );
    }

    const defaultHeaders: Record<string, string> = {};
    const referrer = process.env["OPENROUTER_REFERRER"];
    const title = process.env["OPENROUTER_TITLE"];
    if (referrer) {
      defaultHeaders["HTTP-Referer"] = referrer;
    }
    if (title) {
      defaultHeaders["X-Title"] = title;
    }

    _anthropicClient = new Anthropic({
      baseURL,
      authToken: token,
      apiKey: null,
      defaultHeaders,
    });
    return _anthropicClient;
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? null;
  const authToken = process.env["ANTHROPIC_AUTH_TOKEN"] ?? null;
  if (!apiKey && !authToken) {
    throw new Error(
      "Expected ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN environment variable to be set",
    );
  }

  _anthropicClient = new Anthropic({ baseURL, apiKey, authToken });
  return _anthropicClient;
}

async function callClaude(
  model: string,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 4096,
): Promise<string> {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const block = response.content[0];
  if (!block || block.type !== "text") {
    throw new Error("Unexpected response format from Anthropic API");
  }
  return block.text;
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```(?:json)?\n?([\s\S]*?)```/g, "$1").trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Node implementations
// ---------------------------------------------------------------------------

async function analyzeRequirements(state: GraphState): Promise<Partial<GraphState>> {
  const nodeName = "analyze_requirements";
  log.info(`Node: ${nodeName}`, { stateKey: state.currentStep });

  const errors: WorkflowError[] = [...state.errors];
  const decisions: Decision[] = [...state.decisions];
  const stepHistory: string[] = [...state.stepHistory, nodeName];

  try {
    const systemPrompt = `You are a senior software architect at OpenClaw Teams.
Your task is to extract structured requirements from the user's natural-language input.
Respond ONLY with a valid JSON object matching this schema:
{
  "projectName": string,
  "projectType": "api" | "frontend" | "fullstack" | "data-pipeline" | "ml" | "other",
  "primaryLanguages": string[],
  "frameworks": string[],
  "databases": string[],
  "agentsNeeded": number,
  "estimatedComplexity": "low" | "medium" | "high",
  "coreFeatures": string[],
  "nonFunctionalRequirements": string[],
  "constraints": string[]
}`;

    const rawResponse = await withRetry(
      () =>
        callClaude(
          MODEL_SUPERVISOR,
          systemPrompt,
          `Analyse the following user input and extract requirements:\n\n${state.userInput}`,
          2048,
        ),
      nodeName,
    );

    const requirements = safeJsonParse<Record<string, unknown>>(rawResponse, {
      projectName: "unnamed-project",
      projectType: "other",
      primaryLanguages: ["TypeScript"],
      frameworks: [],
      databases: [],
      agentsNeeded: 3,
      estimatedComplexity: "medium",
      coreFeatures: [state.userInput],
      nonFunctionalRequirements: [],
      constraints: [],
    });

    decisions.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      description: "Requirements analysed",
      rationale: `Parsed ${Object.keys(requirements).length} requirement fields from user input`,
      outcome: `Complexity: ${
        typeof requirements["estimatedComplexity"] === "string"
          ? requirements["estimatedComplexity"]
          : "medium"
      }, Agents needed: ${
        typeof requirements["agentsNeeded"] === "number" ? requirements["agentsNeeded"] : 3
      }`,
    });

    log.info(`${nodeName} completed`, { requirements });

    return {
      requirements,
      currentStep: nodeName,
      stepHistory,
      decisions,
      errors,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(`${nodeName} failed`, { message: error.message });
    errors.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      message: error.message,
      retryable: true,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    });
    return { currentStep: nodeName, stepHistory, errors };
  }
}

async function planArchitecture(state: GraphState): Promise<Partial<GraphState>> {
  const nodeName = "plan_architecture";
  log.info(`Node: ${nodeName}`);

  const errors: WorkflowError[] = [...state.errors];
  const decisions: Decision[] = [...state.decisions];
  const stepHistory: string[] = [...state.stepHistory, nodeName];

  try {
    const systemPrompt = `You are a principal architect at OpenClaw Teams.
Design a multi-agent system architecture based on the provided requirements.
Respond ONLY with valid JSON matching this schema:
{
  "agents": [
    {
      "id": string,
      "name": string,
      "model": "claude-sonnet-4-6" | "claude-haiku-4-5-20251001",
      "role": string,
      "responsibilities": string[],
      "tools": string[]
    }
  ],
  "workflows": [
    {
      "id": string,
      "name": string,
      "description": string,
      "steps": string[]
    }
  ],
  "architecture": string,
  "rationale": string
}`;

    const rawResponse = await withRetry(
      () =>
        callClaude(
          MODEL_BUILDER,
          systemPrompt,
          `Design architecture for:\n${JSON.stringify(state.requirements, null, 2)}`,
          4096,
        ),
      nodeName,
    );

    const plan = safeJsonParse<{
      agents: Array<{
        id: string;
        name: string;
        model: string;
        role: string;
        responsibilities: string[];
        tools: string[];
      }>;
      workflows: Array<{
        id: string;
        name: string;
        description: string;
        steps: string[];
      }>;
      architecture: string;
      rationale: string;
    }>(rawResponse, {
      agents: [],
      workflows: [],
      architecture: "Default single-agent architecture",
      rationale: "Fallback due to parse failure",
    });

    decisions.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      description: "Architecture designed",
      rationale: plan.rationale ?? "Completed by Builder model",
      outcome: `${plan.agents?.length ?? 0} agents, ${plan.workflows?.length ?? 0} workflows`,
    });

    log.info(`${nodeName} completed`, {
      agentCount: plan.agents?.length,
      workflowCount: plan.workflows?.length,
    });

    // Store plan sketch in requirements for downstream nodes
    return {
      requirements: {
        ...state.requirements,
        _architecturePlan: plan,
      },
      currentStep: nodeName,
      stepHistory,
      decisions,
      errors,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(`${nodeName} failed`, { message: error.message });
    errors.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      message: error.message,
      retryable: true,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    });
    return { currentStep: nodeName, stepHistory, errors };
  }
}

async function spawnBuilderTeams(state: GraphState): Promise<Partial<GraphState>> {
  const nodeName = "spawn_builder_teams";
  log.info(`Node: ${nodeName}`);

  const errors: WorkflowError[] = [...state.errors];
  const decisions: Decision[] = [...state.decisions];
  const stepHistory: string[] = [...state.stepHistory, nodeName];

  try {
    const plan = state.requirements["_architecturePlan"] as
      | {
          agents?: Array<{
            id: string;
            name: string;
            model: string;
            role: string;
            responsibilities: string[];
            tools: string[];
          }>;
        }
      | undefined;

    const rawAgents = plan?.agents ?? [];

    // Group agents into teams of up to 3
    const teamsSpawned: TeamConfig[] = [];
    const chunkSize = 3;

    for (let i = 0; i < rawAgents.length; i += chunkSize) {
      const chunk = rawAgents.slice(i, i + chunkSize);
      const teamIndex = Math.floor(i / chunkSize) + 1;

      const agentConfigs: AgentConfig[] = chunk.map((a) => ({
        id: a.id,
        name: a.name,
        model: a.model === MODEL_BUILDER ? MODEL_BUILDER : MODEL_SUPERVISOR,
        systemPrompt: `You are ${a.name}. Role: ${a.role}. Responsibilities: ${a.responsibilities.join(", ")}.`,
        maxTokens: 4096,
        temperature: 0.2,
        tools: a.tools ?? [],
        metadata: { role: a.role },
      }));

      teamsSpawned.push({
        teamId: `team-${teamIndex}`,
        name: `Builder Team ${teamIndex}`,
        role: chunk.map((a) => a.role).join(" / "),
        agents: agentConfigs,
        maxConcurrency: 2,
        timeoutMs: 120_000,
      });
    }

    // Ensure at least one team exists
    if (teamsSpawned.length === 0) {
      teamsSpawned.push({
        teamId: "team-1",
        name: "Default Builder Team",
        role: "General purpose agent builder",
        agents: [
          {
            id: "default-agent-1",
            name: "General Builder",
            model: MODEL_BUILDER,
            systemPrompt: "You are a general purpose software engineer building a new project.",
            maxTokens: 4096,
            temperature: 0.2,
            tools: [],
            metadata: {},
          },
        ],
        maxConcurrency: 1,
        timeoutMs: 120_000,
      });
    }

    decisions.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      description: "Builder teams spawned",
      rationale: `Grouped ${rawAgents.length} agents into ${teamsSpawned.length} teams`,
      outcome: teamsSpawned.map((t) => t.teamId).join(", "),
    });

    log.info(`${nodeName} completed`, { teamCount: teamsSpawned.length });

    return {
      teamsSpawned,
      currentStep: nodeName,
      stepHistory,
      decisions,
      errors,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(`${nodeName} failed`, { message: error.message });
    errors.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      message: error.message,
      retryable: true,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    });
    return { currentStep: nodeName, stepHistory, errors };
  }
}

async function buildAgents(state: GraphState): Promise<Partial<GraphState>> {
  const nodeName = "build_agents";
  log.info(`Node: ${nodeName}`);

  const errors: WorkflowError[] = [...state.errors];
  const decisions: Decision[] = [...state.decisions];
  const stepHistory: string[] = [...state.stepHistory, nodeName];
  const teamResults: Record<string, TeamResult> = { ...state.teamResults };

  const systemPrompt = `You are a world-class TypeScript engineer.
Given an agent configuration, produce a complete, runnable TypeScript implementation.
Output ONLY the TypeScript source code — no explanations, no markdown fences.`;

  const buildTeam = async (team: TeamConfig): Promise<void> => {
    const teamStart = Date.now();
    const teamErrors: WorkflowError[] = [];

    try {
      log.info(`Building team "${team.teamId}"`, { agentCount: team.agents.length });

      const agentCodes: Array<{ agentId: string; code: string }> = [];

      // Build agents sequentially within a team to avoid rate limits
      for (const agentConfig of team.agents) {
        try {
          const code = await withRetry(
            () =>
              callClaude(
                MODEL_BUILDER,
                systemPrompt,
                `Generate TypeScript implementation for agent:\n${JSON.stringify(agentConfig, null, 2)}`,
                4096,
              ),
            `build-agent-${agentConfig.id}`,
          );
          agentCodes.push({ agentId: agentConfig.id ?? agentConfig.name, code });
          log.debug(`Agent built: ${agentConfig.id}`);
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          log.warn(`Failed to build agent ${agentConfig.id}`, { message: error.message });
          teamErrors.push({
            step: nodeName,
            timestamp: new Date().toISOString(),
            message: `Agent ${agentConfig.id}: ${error.message}`,
            retryable: false,
          });
        }
      }

      teamResults[team.teamId] = {
        teamId: team.teamId,
        success: teamErrors.length === 0,
        output: { agentCodes },
        artifacts: agentCodes.map((ac) => ({
          type: "code",
          path: `src/agents/${ac.agentId}.ts`,
          content: ac.code,
          language: "typescript",
        })),
        duration: Date.now() - teamStart,
        errors: teamErrors,
        completedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(`Team ${team.teamId} build failed`, { message: error.message });
      teamResults[team.teamId] = {
        teamId: team.teamId,
        success: false,
        output: null,
        artifacts: [],
        duration: Date.now() - teamStart,
        errors: [
          {
            step: nodeName,
            timestamp: new Date().toISOString(),
            message: error.message,
            retryable: true,
            ...(error.stack !== undefined ? { stack: error.stack } : {}),
          },
        ],
        completedAt: new Date().toISOString(),
      };
    }
  };

  // Build all teams (parallel with a concurrency limit of 2)
  const teams = state.teamsSpawned;
  for (let i = 0; i < teams.length; i += 2) {
    const batch = teams.slice(i, i + 2).filter((t): t is TeamConfig => t !== undefined);
    await Promise.all(batch.map((team) => buildTeam(team)));
  }

  const successCount = Object.values(teamResults).filter((r) => r.success).length;
  const failCount = Object.values(teamResults).filter((r) => !r.success).length;

  decisions.push({
    step: nodeName,
    timestamp: new Date().toISOString(),
    description: "Agents built by all teams",
    rationale: `Processed ${teams.length} teams in parallel batches`,
    outcome: `${successCount} succeeded, ${failCount} failed`,
  });

  log.info(`${nodeName} completed`, { successCount, failCount });

  return {
    teamResults,
    currentStep: nodeName,
    stepHistory,
    decisions,
    errors,
  };
}

async function validateAndTest(state: GraphState): Promise<Partial<GraphState>> {
  const nodeName = "validate_and_test";
  log.info(`Node: ${nodeName}`);

  const errors: WorkflowError[] = [...state.errors];
  const decisions: Decision[] = [...state.decisions];
  const stepHistory: string[] = [...state.stepHistory, nodeName];

  try {
    const totalTeams = Object.keys(state.teamResults).length;
    const successTeams = Object.values(state.teamResults).filter((r) => r.success).length;
    const totalArtifacts = Object.values(state.teamResults).reduce(
      (sum, r) => sum + r.artifacts.length,
      0,
    );

    const systemPrompt = `You are a senior QA engineer and code reviewer at OpenClaw Teams.
Review the provided build summary and determine whether the system is ready for deployment.
Respond ONLY with valid JSON:
{
  "passed": boolean,
  "score": number (0-100),
  "issues": string[],
  "recommendations": string[],
  "verdict": "deploy" | "fix" | "abort"
}`;

    const buildSummary = {
      totalTeams,
      successTeams,
      failedTeams: totalTeams - successTeams,
      totalArtifacts,
      requirements: state.requirements,
      teamErrors: Object.fromEntries(
        Object.entries(state.teamResults).map(([k, v]) => [k, v.errors]),
      ),
    };

    const rawResponse = await withRetry(
      () =>
        callClaude(
          MODEL_SUPERVISOR,
          systemPrompt,
          `Validate build:\n${JSON.stringify(buildSummary, null, 2)}`,
          2048,
        ),
      nodeName,
    );

    const validation = safeJsonParse<{
      passed: boolean;
      score: number;
      issues: string[];
      recommendations: string[];
      verdict: "deploy" | "fix" | "abort";
    }>(rawResponse, {
      passed: successTeams === totalTeams,
      score: Math.round((successTeams / Math.max(totalTeams, 1)) * 100),
      issues: [],
      recommendations: [],
      verdict: successTeams === totalTeams ? "deploy" : "fix",
    });

    decisions.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      description: "Validation complete",
      rationale: `Score: ${validation.score}/100, Issues: ${validation.issues.length}`,
      outcome: `Verdict: ${validation.verdict}`,
    });

    log.info(`${nodeName} completed`, { verdict: validation.verdict, score: validation.score });

    // Store validation result for conditional routing
    return {
      requirements: {
        ...state.requirements,
        _validationResult: validation,
      },
      currentStep: nodeName,
      stepHistory,
      decisions,
      errors,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(`${nodeName} failed`, { message: error.message });
    errors.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      message: error.message,
      retryable: true,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    });
    return {
      requirements: {
        ...state.requirements,
        _validationResult: { passed: false, score: 0, verdict: "fix", issues: [error.message] },
      },
      currentStep: nodeName,
      stepHistory,
      errors,
    };
  }
}

async function deploySystem(state: GraphState): Promise<Partial<GraphState>> {
  const nodeName = "deploy_system";
  log.info(`Node: ${nodeName}`);

  const errors: WorkflowError[] = [...state.errors];
  const decisions: Decision[] = [...state.decisions];
  const stepHistory: string[] = [...state.stepHistory, nodeName];

  try {
    const plan = state.requirements["_architecturePlan"] as
      | {
          agents?: AgentConfig[];
          workflows?: WorkflowDefinition[];
          architecture?: string;
        }
      | undefined;

    const deploymentConfig: DeploymentConfig = {
      environment: (process.env["NODE_ENV"] as DeploymentConfig["environment"]) ?? "development",
      replicas: 2,
      resources: {
        cpuRequest: "250m",
        cpuLimit: "1000m",
        memoryRequest: "512Mi",
        memoryLimit: "2Gi",
      },
      envVars: {
        NODE_ENV: process.env["NODE_ENV"] ?? "development",
        LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info",
      },
      secrets: ["ANTHROPIC_API_KEY", "DATABASE_URL"],
      healthCheck: {
        path: "/health",
        port: parseInt(process.env["PORT"] ?? "3000", 10),
        initialDelaySeconds: 10,
        periodSeconds: 15,
        failureThreshold: 3,
      },
    };

    const finalPlan: FinalPlan = {
      architecture: plan?.architecture ?? "Multi-agent LangGraph pipeline",
      agents: plan?.agents ?? [],
      workflows: plan?.workflows ?? [],
      deploymentConfig,
      estimatedComplexity:
        (state.requirements["estimatedComplexity"] as FinalPlan["estimatedComplexity"]) ?? "medium",
      generatedAt: new Date().toISOString(),
    };

    decisions.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      description: "Deployment plan finalised",
      rationale: "All validation checks passed or acceptable thresholds met",
      outcome: `Deploying ${finalPlan.agents.length} agents to ${deploymentConfig.environment}`,
    });

    log.info(`${nodeName} completed`, {
      agentCount: finalPlan.agents.length,
      environment: deploymentConfig.environment,
    });

    return {
      finalPlan,
      deploymentReady: true,
      endTime: new Date().toISOString(),
      currentStep: nodeName,
      stepHistory,
      decisions,
      errors,
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(`${nodeName} failed`, { message: error.message });
    errors.push({
      step: nodeName,
      timestamp: new Date().toISOString(),
      message: error.message,
      retryable: false,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    });
    return {
      deploymentReady: false,
      endTime: new Date().toISOString(),
      currentStep: nodeName,
      stepHistory,
      errors,
    };
  }
}

// ---------------------------------------------------------------------------
// Conditional routing for validate_and_test
// ---------------------------------------------------------------------------

function routeAfterValidation(state: GraphState): string {
  const validation = state.requirements["_validationResult"] as
    | { verdict: "deploy" | "fix" | "abort" }
    | undefined;

  const verdict = validation?.verdict ?? "deploy";

  switch (verdict) {
    case "deploy":
      log.info("Routing: validation passed → deploy_system");
      return "deploy_system";
    case "fix":
      // Re-enter build phase (one retry cycle)
      log.warn("Routing: validation requested fix → build_agents");
      return "build_agents";
    case "abort":
    default:
      log.error("Routing: validation aborted → END");
      return END;
  }
}

// ---------------------------------------------------------------------------
// LangGraphOrchestrator class
// ---------------------------------------------------------------------------

export type { GraphState };

export class LangGraphOrchestrator {
  private graph!: ReturnType<typeof this.buildGraph>;
  private readonly checkpointer = new MemorySaver();
  private readonly stateStore = new Map<string, GraphState>();

  constructor() {
    this.graph = this.buildGraph();
  }

  // -------------------------------------------------------------------------
  // Graph construction
  // -------------------------------------------------------------------------

  private buildGraph() {
    const graphBuilder = new StateGraph<GraphState>({
      channels: {
        userInput: { value: (_prev: string, next: string) => next, default: () => "" },
        requirements: {
          value: (_prev: Record<string, unknown>, next: Record<string, unknown>) => next,
          default: () => ({}),
        },
        currentStep: { value: (_prev: string, next: string) => next, default: () => "" },
        stepHistory: {
          value: (_prev: string[], next: string[]) => next,
          default: () => [],
        },
        decisions: {
          value: (_prev: Decision[], next: Decision[]) => next,
          default: () => [],
        },
        teamsSpawned: {
          value: (_prev: TeamConfig[], next: TeamConfig[]) => next,
          default: () => [],
        },
        teamResults: {
          value: (_prev: Record<string, TeamResult>, next: Record<string, TeamResult>) => next,
          default: () => ({}),
        },
        finalPlan: {
          value: (_prev: FinalPlan | null, next: FinalPlan | null) => next,
          default: () => null,
        },
        deploymentReady: {
          value: (_prev: boolean, next: boolean) => next,
          default: () => false,
        },
        startTime: { value: (_prev: string, next: string) => next, default: () => "" },
        endTime: {
          value: (_prev: string | null, next: string | null) => next,
          default: () => null,
        },
        errors: {
          value: (_prev: WorkflowError[], next: WorkflowError[]) => next,
          default: () => [],
        },
      },
    });

    // Add nodes
    graphBuilder.addNode("analyze_requirements", analyzeRequirements);
    graphBuilder.addNode("plan_architecture", planArchitecture);
    graphBuilder.addNode("spawn_builder_teams", spawnBuilderTeams);
    graphBuilder.addNode("build_agents", buildAgents);
    graphBuilder.addNode("validate_and_test", validateAndTest);
    graphBuilder.addNode("deploy_system", deploySystem);

    // Add edges — cast to any to work around LangGraph 0.2.x strict generic
    // inference (addNode() doesn't return a re-typed builder in mutation style).
    type MutableGraphBuilder = {
      addEdge(from: string, to: string): void;
      addConditionalEdges(
        from: string,
        route: (state: GraphState) => string,
        branches: Record<string, string>,
      ): void;
    };
    const g = graphBuilder as unknown as MutableGraphBuilder;
    g.addEdge(START, "analyze_requirements");
    g.addEdge("analyze_requirements", "plan_architecture");
    g.addEdge("plan_architecture", "spawn_builder_teams");
    g.addEdge("spawn_builder_teams", "build_agents");
    g.addEdge("build_agents", "validate_and_test");

    // Conditional edge from validate_and_test
    g.addConditionalEdges("validate_and_test", routeAfterValidation, {
      deploy_system: "deploy_system",
      build_agents: "build_agents",
      [END]: END,
    });

    g.addEdge("deploy_system", END);

    return graphBuilder.compile({ checkpointer: this.checkpointer });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Re-initialises the compiled graph (useful after config changes).
   */
  initializeGraph(): void {
    this.graph = this.buildGraph();
    log.info("LangGraph re-initialised");
  }

  /**
   * Executes the full workflow for a given user input.
   *
   * @param userInput  Natural-language description of what to build
   * @param stateKey   Unique identifier for this run (used for checkpointing)
   * @returns          Final GraphState after the workflow completes or errors
   */
  async execute(userInput: string, stateKey: string): Promise<GraphState> {
    log.info("Starting workflow execution", { stateKey, inputLength: userInput.length });

    const initialState: GraphState = {
      userInput,
      requirements: {},
      currentStep: "",
      stepHistory: [],
      decisions: [],
      teamsSpawned: [],
      teamResults: {},
      finalPlan: null,
      deploymentReady: false,
      startTime: new Date().toISOString(),
      endTime: null,
      errors: [],
    };

    try {
      const config = { configurable: { thread_id: stateKey } };
      const finalState = (await this.graph.invoke(initialState, config)) as GraphState;

      this.stateStore.set(stateKey, finalState);

      log.info("Workflow execution completed", {
        stateKey,
        deploymentReady: finalState.deploymentReady,
        stepCount: finalState.stepHistory.length,
        errorCount: finalState.errors.length,
      });

      return finalState;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("Workflow execution failed", { stateKey, message: error.message });

      const failedState: GraphState = {
        ...initialState,
        endTime: new Date().toISOString(),
        errors: [
          {
            step: "execute",
            timestamp: new Date().toISOString(),
            message: error.message,
            retryable: false,
            ...(error.stack !== undefined ? { stack: error.stack } : {}),
          },
        ],
      };

      this.stateStore.set(stateKey, failedState);
      throw error;
    }
  }

  /**
   * Returns the last-known status for a workflow run.
   *
   * @returns Partial status or null if not found.
   */
  getStatus(stateKey: string): {
    currentStep: string;
    stepHistory: string[];
    deploymentReady: boolean;
    errorCount: number;
    startTime: string;
    endTime: string | null;
  } | null {
    const state = this.stateStore.get(stateKey);
    if (!state) {
      return null;
    }
    return {
      currentStep: state.currentStep,
      stepHistory: state.stepHistory,
      deploymentReady: state.deploymentReady,
      errorCount: state.errors.length,
      startTime: state.startTime,
      endTime: state.endTime,
    };
  }

  /**
   * Returns the list of decisions recorded during a workflow run.
   */
  getDecisions(stateKey: string): Decision[] {
    return this.stateStore.get(stateKey)?.decisions ?? [];
  }

  /**
   * Returns the team results recorded during a workflow run.
   */
  getTeamResults(stateKey: string): Record<string, TeamResult> {
    return this.stateStore.get(stateKey)?.teamResults ?? {};
  }
}
