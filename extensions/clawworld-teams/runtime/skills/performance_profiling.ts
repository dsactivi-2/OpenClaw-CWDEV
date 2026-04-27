/**
 * Performance Profiling Skill
 * Agent and workflow performance analysis with Prometheus metrics integration.
 *
 * @module skills/performance_profiling
 */

import Joi from "joi";
import * as promClient from "prom-client";
import { createLogger } from "../src/utils/logger.js";

const logger = createLogger("PerformanceProfilingSkill");

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** A single timing sample */
export interface TimingSample {
  label: string;
  startedAt: number; // Unix ms
  durationMs: number;
}

/** Token and cost observation for a single call */
export interface TokenObservation {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  recordedAt: string; // ISO-8601
}

/** Profiling result for a single agent call */
export interface AgentCallProfile {
  profileId: string;
  agentId: string;
  functionName: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  success: boolean;
  error: string | null;
  startedAt: string;
  completedAt: string;
}

/** Profiling result for an end-to-end workflow run */
export interface WorkflowProfile {
  workflowId: string;
  steps: StepProfile[];
  totalDurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  startedAt: string;
  completedAt: string;
}

/** Profiling data for a single workflow step */
export interface StepProfile {
  stepId: string;
  agentId: string;
  durationMs: number;
  tokens: number;
  costUsd: number;
  startedAt: string;
  completedAt: string;
}

/** A bottleneck node identified in profiling data */
export interface Bottleneck {
  nodeId: string;
  type: "step" | "agent";
  durationMs: number;
  percentageOfTotal: number;
  recommendation: string;
}

/** Flame graph node for hierarchical visualisation */
export interface FlameNode {
  name: string;
  value: number; // duration in ms
  children: FlameNode[];
}

/** Monthly token and cost usage for an agent */
export interface MonthlyTokenUsage {
  agentId: string;
  month: string; // YYYY-MM
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  avgTokensPerCall: number;
}

/** Monthly cost usage compared to a budget */
export interface MonthlyCostUsage {
  agentId: string;
  month: string; // YYYY-MM
  totalCostUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  utilizationPercent: number;
  overBudget: boolean;
  callCount: number;
}

/** Full performance summary for an agent */
export interface PerformanceReport {
  reportId: string;
  agentId: string;
  generatedAt: string;
  totalCalls: number;
  successRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  avgTokensPerCall: number;
  totalTokensConsumed: number;
  totalCostUsd: number;
  bottlenecks: Bottleneck[];
  recommendations: string[];
  callHistory: AgentCallProfile[];
}

/** Cost per token in USD for common models (Anthropic direct + OpenRouter names) */
const MODEL_COST_PER_TOKEN: Record<string, number> = {
  // Anthropic direct
  "claude-opus-4-6": 0.000_015,
  "claude-sonnet-4-6": 0.000_003,
  "claude-haiku-4-5-20251001": 0.000_000_25,
  // OpenRouter prefixed
  "anthropic/claude-opus-4-5": 0.000_015,
  "anthropic/claude-sonnet-4-5": 0.000_003,
  "anthropic/claude-haiku-3-5": 0.000_000_25,
  default: 0.000_003,
};

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const profileAgentCallSchema = Joi.object({
  agentId: Joi.string().min(1).required(),
  model: Joi.string().default("default"),
  inputTokensHint: Joi.number().integer().min(0).default(0),
  outputTokensHint: Joi.number().integer().min(0).default(0),
});

const profileWorkflowSchema = Joi.object({
  workflowId: Joi.string().min(1).required(),
});

const trackUsageSchema = Joi.object({
  agentId: Joi.string().min(1).required(),
  month: Joi.string()
    .pattern(/^\d{4}-(?:0[1-9]|1[0-2])$/)
    .required(),
});

const trackCostSchema = Joi.object({
  agentId: Joi.string().min(1).required(),
  month: Joi.string()
    .pattern(/^\d{4}-(?:0[1-9]|1[0-2])$/)
    .required(),
  budgetUsd: Joi.number().min(0).default(100),
});

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class PerformanceProfilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerformanceProfilingError";
  }
}

export class ProfilingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfilingValidationError";
  }
}

// ---------------------------------------------------------------------------
// Prometheus metrics (lazily initialised once per process)
// ---------------------------------------------------------------------------

let metricsInitialised = false;

let agentCallDuration: promClient.Histogram<string>;
let agentTokensUsed: promClient.Counter<string>;
let agentCostUsd: promClient.Counter<string>;
let agentCallErrors: promClient.Counter<string>;
let workflowDuration: promClient.Histogram<string>;

function ensureMetrics(): void {
  if (metricsInitialised) {
    return;
  }

  // Use the default registry; safe to call multiple times in the same process
  // because prom-client deduplicates by metric name.
  try {
    agentCallDuration = new promClient.Histogram({
      name: "openclaw_agent_call_duration_ms",
      help: "Duration of agent function calls in milliseconds",
      labelNames: ["agent_id", "function_name", "success"],
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
    });

    agentTokensUsed = new promClient.Counter({
      name: "openclaw_agent_tokens_total",
      help: "Total tokens consumed by each agent",
      labelNames: ["agent_id", "model", "token_type"],
    });

    agentCostUsd = new promClient.Counter({
      name: "openclaw_agent_cost_usd_total",
      help: "Cumulative estimated cost in USD per agent",
      labelNames: ["agent_id", "model"],
    });

    agentCallErrors = new promClient.Counter({
      name: "openclaw_agent_errors_total",
      help: "Total number of failed agent calls",
      labelNames: ["agent_id"],
    });

    workflowDuration = new promClient.Histogram({
      name: "openclaw_workflow_duration_ms",
      help: "End-to-end workflow execution time in milliseconds",
      labelNames: ["workflow_id"],
      buckets: [100, 500, 1000, 5000, 15000, 60000, 300000],
    });

    promClient.collectDefaultMetrics({ prefix: "openclaw_" });
    metricsInitialised = true;
    logger.debug("Prometheus metrics initialised");
  } catch (err) {
    // Metrics may already be registered in hot-reload scenarios — safe to ignore
    logger.warn("Prometheus metric registration skipped (already registered)", { err });
    metricsInitialised = true;
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function costPerToken(model: string): number {
  return MODEL_COST_PER_TOKEN[model] ?? MODEL_COST_PER_TOKEN["default"] ?? 0;
}

/** Returns the YYYY-MM string for a given ISO-8601 date */
function toYearMonth(isoDate: string): string {
  return isoDate.slice(0, 7);
}

// ---------------------------------------------------------------------------
// PerformanceProfilingSkill
// ---------------------------------------------------------------------------

/**
 * PerformanceProfilingSkill
 *
 * Instruments agent calls and workflows, detects bottlenecks, generates
 * flame graph data, tracks token/cost budgets, and exposes Prometheus metrics.
 *
 * @example
 * ```ts
 * const profiler = new PerformanceProfilingSkill();
 * const result = await profiler.profileAgentCall('agent-1', myAgentFn);
 * const report = profiler.generatePerformanceReport('agent-1');
 * ```
 */
export class PerformanceProfilingSkill {
  /** All collected agent call profiles, keyed by agentId */
  private readonly callProfiles = new Map<string, AgentCallProfile[]>();

  /** Accumulated workflow profiles, keyed by workflowId */
  private readonly workflowProfiles = new Map<string, WorkflowProfile[]>();

  constructor() {
    ensureMetrics();
    logger.info("PerformanceProfilingSkill initialised");
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Wraps an async function, measures its execution time, and records token
   * consumption (if the returned object contains token metadata).
   *
   * @param agentId - Identifier of the agent being profiled
   * @param fn - Async function to profile
   * @param options - Optional model + token hints
   * @returns Object containing the function's return value and the profile
   */
  async profileAgentCall<T>(
    agentId: string,
    fn: () => Promise<T>,
    options: {
      model?: string;
      inputTokensHint?: number;
      outputTokensHint?: number;
    } = {},
  ): Promise<{ result: T; profile: AgentCallProfile }> {
    const { error } = profileAgentCallSchema.validate({
      agentId,
      model: options.model,
      inputTokensHint: options.inputTokensHint,
      outputTokensHint: options.outputTokensHint,
    });
    if (error) {
      throw new ProfilingValidationError(error.message);
    }

    const model = options.model ?? "default";
    let inputTokens = options.inputTokensHint ?? 0;
    const functionName = fn.name || "anonymous";
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    let result: T;
    let success = true;
    let errorMessage: string | null = null;
    let outputTokens = options.outputTokensHint ?? 0;

    try {
      result = await fn();

      // Attempt to extract token usage from Anthropic SDK response shapes
      if (result != null && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (r["usage"] != null && typeof r["usage"] === "object") {
          const usage = r["usage"] as Record<string, number>;
          if (typeof usage["input_tokens"] === "number") {
            inputTokens = usage["input_tokens"];
          }
          if (typeof usage["output_tokens"] === "number") {
            outputTokens = usage["output_tokens"];
          }
        }
      }
    } catch (err) {
      success = false;
      errorMessage = err instanceof Error ? err.message : String(err);
      agentCallErrors.labels({ agent_id: agentId }).inc();
      // Re-throw after recording so the caller still sees the error
      result = undefined as unknown as T;
    }

    const durationMs = Date.now() - t0;
    const totalTokens = inputTokens + outputTokens;
    const estimatedCostUsd = totalTokens * costPerToken(model);
    const completedAt = new Date().toISOString();

    // Update Prometheus
    agentCallDuration
      .labels({ agent_id: agentId, function_name: functionName, success: String(success) })
      .observe(durationMs);
    agentTokensUsed.labels({ agent_id: agentId, model, token_type: "input" }).inc(inputTokens);
    agentTokensUsed.labels({ agent_id: agentId, model, token_type: "output" }).inc(outputTokens);
    agentCostUsd.labels({ agent_id: agentId, model }).inc(estimatedCostUsd);

    const profile: AgentCallProfile = {
      profileId: generateId(),
      agentId,
      functionName,
      durationMs,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd,
      success,
      error: errorMessage,
      startedAt,
      completedAt,
    };

    if (!this.callProfiles.has(agentId)) {
      this.callProfiles.set(agentId, []);
    }
    this.callProfiles.get(agentId)?.push(profile);

    logger.debug("Agent call profiled", {
      agentId,
      durationMs,
      totalTokens,
      success,
    });

    if (!success) {
      throw new PerformanceProfilingError(errorMessage ?? "Unknown error");
    }

    return { result, profile };
  }

  /**
   * Builds an end-to-end profile for a workflow by aggregating all step-level
   * profiles from recorded agent calls.
   *
   * @param workflowId - Workflow instance ID
   * @param steps - Array of step profiles to aggregate
   * @returns WorkflowProfile
   */
  profileWorkflow(workflowId: string, steps: StepProfile[]): WorkflowProfile {
    const { error } = profileWorkflowSchema.validate({ workflowId });
    if (error) {
      throw new ProfilingValidationError(error.message);
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      throw new ProfilingValidationError("steps must be a non-empty array of StepProfile");
    }

    const totalDurationMs = steps.reduce((s, p) => s + p.durationMs, 0);
    const totalTokens = steps.reduce((s, p) => s + p.tokens, 0);
    const totalCostUsd = steps.reduce((s, p) => s + p.costUsd, 0);

    const startedAt = steps.reduce(
      (min, p) => (p.startedAt < min ? p.startedAt : min),
      steps[0]?.startedAt ?? "",
    );
    const completedAt = steps.reduce(
      (max, p) => (p.completedAt > max ? p.completedAt : max),
      steps[0]?.completedAt ?? "",
    );

    const wfProfile: WorkflowProfile = {
      workflowId,
      steps,
      totalDurationMs,
      totalTokens,
      totalCostUsd,
      startedAt,
      completedAt,
    };

    if (!this.workflowProfiles.has(workflowId)) {
      this.workflowProfiles.set(workflowId, []);
    }
    this.workflowProfiles.get(workflowId)?.push(wfProfile);

    // Record in Prometheus
    workflowDuration.labels({ workflow_id: workflowId }).observe(totalDurationMs);

    logger.info("Workflow profiled", {
      workflowId,
      totalDurationMs,
      stepCount: steps.length,
    });

    return wfProfile;
  }

  /**
   * Identifies the slowest nodes in profiling data.
   *
   * @param profileData - A WorkflowProfile to analyse
   * @param topN - Number of bottlenecks to return (default 3)
   * @returns Array of Bottleneck descriptors sorted by duration descending
   */
  detectBottlenecks(profileData: WorkflowProfile, topN = 3): Bottleneck[] {
    if (!profileData || !Array.isArray(profileData.steps)) {
      throw new ProfilingValidationError("profileData must be a valid WorkflowProfile");
    }

    const totalMs = profileData.totalDurationMs || 1;

    const sorted = [...profileData.steps].sort((a, b) => b.durationMs - a.durationMs);
    const topSteps = sorted.slice(0, topN);

    return topSteps.map((step) => {
      const pct = Math.round((step.durationMs / totalMs) * 100);
      let recommendation = `Step "${step.stepId}" takes ${step.durationMs}ms (${pct}% of total).`;

      if (pct >= 50) {
        recommendation +=
          " Consider caching results, reducing token usage, or parallelising this step.";
      } else if (pct >= 25) {
        recommendation += " Investigate whether this step can be optimised or made async.";
      } else {
        recommendation += " Monitor for regressions but no immediate action required.";
      }

      return {
        nodeId: step.stepId,
        type: "step" as const,
        durationMs: step.durationMs,
        percentageOfTotal: pct,
        recommendation,
      };
    });
  }

  /**
   * Converts profiling data into a hierarchical flame graph structure suitable
   * for rendering with libraries such as d3-flame-graph.
   *
   * @param profileData - WorkflowProfile to convert
   * @returns Root FlameNode
   */
  generateFlameGraph(profileData: WorkflowProfile): FlameNode {
    if (!profileData || !Array.isArray(profileData.steps)) {
      throw new ProfilingValidationError("profileData must be a valid WorkflowProfile");
    }

    // Group steps by agentId to create a two-level flame graph
    const agentMap = new Map<string, number>();
    const stepsByAgent = new Map<string, StepProfile[]>();

    for (const step of profileData.steps) {
      agentMap.set(step.agentId, (agentMap.get(step.agentId) ?? 0) + step.durationMs);
      if (!stepsByAgent.has(step.agentId)) {
        stepsByAgent.set(step.agentId, []);
      }
      stepsByAgent.get(step.agentId)?.push(step);
    }

    const children: FlameNode[] = Array.from(agentMap.entries()).map(([agentId, totalMs]) => ({
      name: agentId,
      value: totalMs,
      children: (stepsByAgent.get(agentId) ?? []).map((s) => ({
        name: s.stepId,
        value: s.durationMs,
        children: [],
      })),
    }));

    return {
      name: `workflow:${profileData.workflowId}`,
      value: profileData.totalDurationMs,
      children,
    };
  }

  /**
   * Aggregates token usage for a specific agent for a given calendar month.
   *
   * @param agentId - Agent to query
   * @param month - Calendar month in YYYY-MM format
   * @returns MonthlyTokenUsage summary
   */
  trackTokenUsage(agentId: string, month: string): MonthlyTokenUsage {
    const { error } = trackUsageSchema.validate({ agentId, month });
    if (error) {
      throw new ProfilingValidationError(error.message);
    }

    const profiles = this.callProfiles.get(agentId) ?? [];
    const monthlyProfiles = profiles.filter((p) => toYearMonth(p.startedAt) === month);

    const inputTokens = monthlyProfiles.reduce((s, p) => s + p.inputTokens, 0);
    const outputTokens = monthlyProfiles.reduce((s, p) => s + p.outputTokens, 0);
    const totalTokens = inputTokens + outputTokens;
    const callCount = monthlyProfiles.length;

    logger.debug("Token usage tracked", { agentId, month, totalTokens, callCount });

    return {
      agentId,
      month,
      totalTokens,
      inputTokens,
      outputTokens,
      callCount,
      avgTokensPerCall: callCount > 0 ? Math.round(totalTokens / callCount) : 0,
    };
  }

  /**
   * Aggregates cost usage for a specific agent for a given calendar month,
   * compared against a configurable budget.
   *
   * @param agentId - Agent to query
   * @param month - Calendar month in YYYY-MM format
   * @param budgetUsd - Monthly budget in USD (default $100)
   * @returns MonthlyCostUsage summary
   */
  trackCostUsage(agentId: string, month: string, budgetUsd = 100): MonthlyCostUsage {
    const { error } = trackCostSchema.validate({ agentId, month, budgetUsd });
    if (error) {
      throw new ProfilingValidationError(error.message);
    }

    const profiles = this.callProfiles.get(agentId) ?? [];
    const monthlyProfiles = profiles.filter((p) => toYearMonth(p.startedAt) === month);

    const totalCostUsd = monthlyProfiles.reduce((s, p) => s + p.estimatedCostUsd, 0);
    const callCount = monthlyProfiles.length;
    const remainingUsd = budgetUsd - totalCostUsd;
    const utilizationPercent = budgetUsd > 0 ? Math.round((totalCostUsd / budgetUsd) * 100) : 0;

    if (totalCostUsd > budgetUsd) {
      logger.warn("Agent is over budget", { agentId, month, totalCostUsd, budgetUsd });
    }

    return {
      agentId,
      month,
      totalCostUsd,
      budgetUsd,
      remainingUsd,
      utilizationPercent,
      overBudget: totalCostUsd > budgetUsd,
      callCount,
    };
  }

  /**
   * Produces a comprehensive performance report for an agent.
   *
   * @param agentId - Agent to report on
   * @returns PerformanceReport with statistical summaries and recommendations
   */
  generatePerformanceReport(agentId: string): PerformanceReport {
    if (!agentId || typeof agentId !== "string") {
      throw new ProfilingValidationError("agentId must be a non-empty string");
    }

    const profiles = this.callProfiles.get(agentId) ?? [];
    const totalCalls = profiles.length;

    const successCount = profiles.filter((p) => p.success).length;
    const successRate = totalCalls > 0 ? Math.round((successCount / totalCalls) * 100) : 0;

    const durations = profiles.map((p) => p.durationMs).sort((a, b) => a - b);
    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length)
        : 0;

    const p50 = percentile(durations, 50);
    const p95 = percentile(durations, 95);
    const p99 = percentile(durations, 99);

    const totalTokens = profiles.reduce((s, p) => s + p.totalTokens, 0);
    const avgTokensPerCall = totalCalls > 0 ? Math.round(totalTokens / totalCalls) : 0;
    const totalCostUsd = profiles.reduce((s, p) => s + p.estimatedCostUsd, 0);

    // Build bottleneck list from top slow calls
    const topCalls = [...profiles].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3);
    const bottlenecks: Bottleneck[] = topCalls.map((p) => ({
      nodeId: p.profileId,
      type: "agent",
      durationMs: p.durationMs,
      percentageOfTotal: avgDurationMs > 0 ? Math.round((p.durationMs / avgDurationMs) * 100) : 0,
      recommendation:
        p.durationMs > p95
          ? "This call is in the p95+ range — investigate prompt length or model latency."
          : "Monitor this call for regressions.",
    }));

    // Generate actionable recommendations
    const recommendations: string[] = [];

    if (successRate < 95) {
      recommendations.push(
        `Error rate is ${100 - successRate}%. Investigate retry logic and model reliability.`,
      );
    }
    if (p95 > 10_000) {
      recommendations.push(
        `p95 latency is ${p95}ms. Consider streaming responses or breaking tasks into smaller calls.`,
      );
    }
    if (avgTokensPerCall > 3000) {
      recommendations.push(
        `Average token usage per call is ${avgTokensPerCall}. Optimise prompts to reduce cost.`,
      );
    }
    if (totalCostUsd > 50) {
      recommendations.push(
        `Total cost for this agent is $${totalCostUsd.toFixed(4)}. Consider switching high-volume tasks to a cheaper model tier.`,
      );
    }
    if (recommendations.length === 0) {
      recommendations.push("Performance looks healthy. Continue monitoring.");
    }

    const report: PerformanceReport = {
      reportId: generateId(),
      agentId,
      generatedAt: new Date().toISOString(),
      totalCalls,
      successRate,
      avgDurationMs,
      p50DurationMs: p50,
      p95DurationMs: p95,
      p99DurationMs: p99,
      avgTokensPerCall,
      totalTokensConsumed: totalTokens,
      totalCostUsd,
      bottlenecks,
      recommendations,
      callHistory: profiles,
    };

    logger.info("Performance report generated", {
      agentId,
      totalCalls,
      successRate,
      avgDurationMs,
      p95,
    });

    return report;
  }

  /**
   * Exposes the current Prometheus metrics as a scrape-ready string.
   * Useful for custom /metrics endpoints.
   */
  async getPrometheusMetrics(): Promise<string> {
    return promClient.register.metrics();
  }

  /**
   * Resets all collected profiles for a given agent (useful in tests).
   *
   * @param agentId - Agent whose profiles should be cleared
   */
  resetProfiles(agentId: string): void {
    this.callProfiles.delete(agentId);
    logger.debug("Profiles reset", { agentId });
  }
}
