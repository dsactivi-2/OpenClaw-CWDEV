/**
 * Workflow Orchestration Skill
 * Manages multi-agent workflow coordination with retry, checkpointing, and lifecycle events.
 *
 * @module skills/workflow_orchestration
 */

import { EventEmitter } from "events";
import Joi from "joi";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "../src/utils/logger.js";

const logger = createLogger("WorkflowOrchestrationSkill");

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Current lifecycle state of a workflow instance */
export type WorkflowStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** A single executable step inside a workflow definition */
export interface OrchestratorStep {
  id: string;
  label: string;
  agentId: string;
  handler: StepHandler;
  retryable: boolean;
  maxRetries: number;
  /** Step IDs to run on success */
  onSuccess: string[];
  /** Step IDs to run on failure */
  onFailure: string[];
  timeoutMs?: number;
}

/** Async function that executes a single workflow step */
export type StepHandler = (input: unknown, context: StepContext) => Promise<unknown>;

/** Runtime context passed to each step handler */
export interface StepContext {
  workflowId: string;
  stepId: string;
  attempt: number;
  startedAt: string;
}

/** Full workflow definition registered with the orchestrator */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  steps: OrchestratorStep[];
  entryPoint: string;
  exitPoints: string[];
  timeoutMs: number;
  metadata: Record<string, unknown>;
}

/** A live workflow execution instance */
export interface WorkflowInstance {
  instanceId: string;
  workflowId: string;
  name: string;
  status: WorkflowStatus;
  input: unknown;
  output: unknown;
  currentStepId: string | null;
  stepHistory: StepExecution[];
  checkpoint: Checkpoint | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  errors: WorkflowExecutionError[];
}

/** Record of a single step execution */
export interface StepExecution {
  stepId: string;
  label: string;
  attempt: number;
  status: "running" | "completed" | "failed" | "skipped";
  input: unknown;
  output: unknown;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  error?: string;
}

/** Saved execution state for pause/resume */
export interface Checkpoint {
  stepId: string;
  stepInput: unknown;
  capturedAt: string;
}

/** Typed workflow execution error */
export interface WorkflowExecutionError {
  stepId: string;
  message: string;
  stack?: string;
  retryable: boolean;
  timestamp: string;
}

/** Input shape for createWorkflow() */
export interface CreateWorkflowInput {
  name: string;
  description?: string;
  steps: OrchestratorStep[];
  entryPoint: string;
  exitPoints: string[];
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

/** Workflow lifecycle event names */
export type WorkflowEvent =
  | "workflow:created"
  | "workflow:started"
  | "workflow:step:started"
  | "workflow:step:completed"
  | "workflow:step:failed"
  | "workflow:paused"
  | "workflow:resumed"
  | "workflow:completed"
  | "workflow:failed"
  | "workflow:cancelled";

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const orchestratorStepSchema = Joi.object({
  id: Joi.string().min(1).required(),
  label: Joi.string().min(1).required(),
  agentId: Joi.string().min(1).required(),
  handler: Joi.function().required(),
  retryable: Joi.boolean().default(false),
  maxRetries: Joi.number().integer().min(0).default(0),
  onSuccess: Joi.array().items(Joi.string()).default([]),
  onFailure: Joi.array().items(Joi.string()).default([]),
  timeoutMs: Joi.number().integer().min(0).optional(),
});

const createWorkflowSchema = Joi.object({
  name: Joi.string().min(1).max(256).required(),
  description: Joi.string().max(1024).optional().default(""),
  steps: Joi.array().items(orchestratorStepSchema).min(1).required(),
  entryPoint: Joi.string().min(1).required(),
  exitPoints: Joi.array().items(Joi.string()).min(1).required(),
  timeoutMs: Joi.number().integer().min(0).default(300_000),
  metadata: Joi.object().unknown(true).default({}),
});

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class WorkflowNotFoundError extends Error {
  constructor(id: string) {
    super(`Workflow not found: ${id}`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowAlreadyRunningError extends Error {
  constructor(instanceId: string) {
    super(`Workflow instance is already running: ${instanceId}`);
    this.name = "WorkflowAlreadyRunningError";
  }
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export class StepTimeoutError extends Error {
  constructor(stepId: string, timeoutMs: number) {
    super(`Step "${stepId}" timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Returns a promise that rejects after `ms` milliseconds */
function timeout<T>(promise: Promise<T>, ms: number, stepId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeoutError(stepId, ms)), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/** Exponential back-off delay: base * 2^attempt (capped at 30 s) */
function backoffMs(attempt: number, baseMs = 500): number {
  return Math.min(baseMs * Math.pow(2, attempt), 30_000);
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// WorkflowOrchestrationSkill
// ---------------------------------------------------------------------------

/**
 * WorkflowOrchestrationSkill
 *
 * Registers workflow definitions and manages their live execution with full
 * lifecycle events, retry/back-off, checkpointing, pause/resume, and
 * graceful cancellation.
 *
 * @example
 * ```ts
 * const orchestrator = new WorkflowOrchestrationSkill();
 * const def = orchestrator.createWorkflow('my-flow', steps);
 * const instance = await orchestrator.executeWorkflow(def.id, { foo: 'bar' });
 * ```
 */
export class WorkflowOrchestrationSkill extends EventEmitter {
  /** Registry of all known workflow definitions, keyed by definition ID */
  private readonly definitions = new Map<string, WorkflowDefinition>();

  /** All live and historical workflow instances, keyed by instance ID */
  private readonly instances = new Map<string, WorkflowInstance>();

  /** Abort controllers for graceful cancellation, keyed by instance ID */
  private readonly abortControllers = new Map<string, AbortController>();

  constructor() {
    super();
    logger.info("WorkflowOrchestrationSkill initialised");
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Registers a new workflow definition and returns it.
   *
   * @param name - Human-readable name for the workflow
   * @param steps - Ordered list of step descriptors
   * @param options - Optional extra settings
   * @returns The registered WorkflowDefinition
   * @throws {WorkflowValidationError} on invalid input
   */
  createWorkflow(
    name: string,
    steps: OrchestratorStep[],
    options: Partial<Omit<CreateWorkflowInput, "name" | "steps">> = {},
  ): WorkflowDefinition {
    const raw: CreateWorkflowInput = {
      name,
      steps,
      entryPoint: options.entryPoint ?? steps[0]?.id ?? "",
      exitPoints: options.exitPoints ?? [steps[steps.length - 1]?.id ?? ""],
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    };

    const { error, value } = createWorkflowSchema.validate(raw, { abortEarly: false });
    if (error) {
      throw new WorkflowValidationError(error.message);
    }

    const validated = value as CreateWorkflowInput;

    // Ensure entryPoint references an existing step
    const stepIds = new Set(validated.steps.map((s) => s.id));
    if (!stepIds.has(validated.entryPoint)) {
      throw new WorkflowValidationError(
        `entryPoint "${validated.entryPoint}" does not match any step id`,
      );
    }

    const definition: WorkflowDefinition = {
      id: uuidv4(),
      name: validated.name,
      description: validated.description ?? "",
      steps: validated.steps,
      entryPoint: validated.entryPoint,
      exitPoints: validated.exitPoints,
      timeoutMs: validated.timeoutMs ?? 300_000,
      metadata: validated.metadata ?? {},
    };

    this.definitions.set(definition.id, definition);
    logger.info("Workflow created", { workflowId: definition.id, name: definition.name });
    this.emit("workflow:created", definition);

    return definition;
  }

  /**
   * Runs a registered workflow definition end-to-end, applying retry and
   * back-off logic for retryable steps.
   *
   * @param workflowId - Definition ID returned by createWorkflow()
   * @param input - Arbitrary input forwarded to the entry step
   * @returns Resolved WorkflowInstance when the workflow reaches an exit point
   * @throws {WorkflowNotFoundError} if workflowId is unknown
   */
  async executeWorkflow(workflowId: string, input: unknown): Promise<WorkflowInstance> {
    const definition = this.definitions.get(workflowId);
    if (!definition) {
      throw new WorkflowNotFoundError(workflowId);
    }

    const instanceId = uuidv4();
    const abortController = new AbortController();
    this.abortControllers.set(instanceId, abortController);

    const instance: WorkflowInstance = {
      instanceId,
      workflowId,
      name: definition.name,
      status: "running",
      input,
      output: null,
      currentStepId: definition.entryPoint,
      stepHistory: [],
      checkpoint: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      errors: [],
    };

    this.instances.set(instanceId, instance);
    logger.info("Workflow execution started", { instanceId, workflowId, name: definition.name });
    this.emit("workflow:started", instance);

    try {
      const stepMap = new Map(definition.steps.map((s) => [s.id, s]));
      let currentStepId: string | null = definition.entryPoint;
      let stepInput: unknown = input;

      const overallTimeout = setTimeout(() => {
        abortController.abort("Workflow global timeout exceeded");
      }, definition.timeoutMs);

      try {
        while (currentStepId !== null) {
          if (abortController.signal.aborted) {
            instance.status = "cancelled";
            break;
          }

          // Handle paused state — wait until resumed or cancelled
          if (instance.status === "paused") {
            await this._waitForResume(instance, abortController.signal);
            // Cast needed: TypeScript narrows to 'paused' inside this block,
            // but _waitForResume mutates status asynchronously.
            if ((instance.status as WorkflowStatus) === "cancelled") {
              break;
            }
          }

          const step = stepMap.get(currentStepId);
          if (!step) {
            throw new Error(`Step "${currentStepId}" not found in workflow definition`);
          }

          instance.currentStepId = currentStepId;
          instance.updatedAt = new Date().toISOString();

          stepInput = await this._executeStep(step, stepInput, instance, abortController.signal);

          // Determine next step
          if (definition.exitPoints.includes(currentStepId)) {
            currentStepId = null; // workflow complete
          } else {
            currentStepId = step.onSuccess[0] ?? null;
          }
        }
      } finally {
        clearTimeout(overallTimeout);
      }

      if (instance.status !== "cancelled") {
        instance.status = "completed";
        instance.output = stepInput;
        instance.completedAt = new Date().toISOString();
        logger.info("Workflow completed", { instanceId });
        this.emit("workflow:completed", instance);
      } else {
        instance.completedAt = new Date().toISOString();
        logger.warn("Workflow cancelled", { instanceId });
        this.emit("workflow:cancelled", instance);
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        // AbortController fired → treat as cancellation, not failure
        if (instance.status !== "cancelled") {
          instance.status = "cancelled";
        }
        instance.completedAt = new Date().toISOString();
        logger.warn("Workflow cancelled via abort", { instanceId });
        this.emit("workflow:cancelled", instance);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        instance.status = "failed";
        instance.completedAt = new Date().toISOString();
        instance.errors.push({
          stepId: instance.currentStepId ?? "unknown",
          message,
          ...(stack !== undefined ? { stack } : {}),
          retryable: false,
          timestamp: new Date().toISOString(),
        });
        logger.error("Workflow failed", { instanceId, message });
        this.emit("workflow:failed", instance, err);
      }
    } finally {
      this.abortControllers.delete(instanceId);
    }

    return instance;
  }

  /**
   * Pauses a running workflow at the next safe checkpoint.
   *
   * @param workflowId - Instance ID of a running workflow
   * @throws {WorkflowNotFoundError} if the instance does not exist
   */
  pauseWorkflow(workflowId: string): void {
    const instance = this._getInstance(workflowId);
    if (instance.status !== "running") {
      logger.warn("Pause called on non-running workflow", {
        instanceId: workflowId,
        status: instance.status,
      });
      return;
    }
    instance.status = "paused";
    instance.updatedAt = new Date().toISOString();

    // Save checkpoint at current step
    if (instance.currentStepId !== null) {
      instance.checkpoint = {
        stepId: instance.currentStepId,
        stepInput: instance.input,
        capturedAt: new Date().toISOString(),
      };
    }

    logger.info("Workflow paused", { instanceId: workflowId });
    this.emit("workflow:paused", instance);
  }

  /**
   * Resumes a previously paused workflow from its last checkpoint.
   *
   * @param workflowId - Instance ID of a paused workflow
   * @throws {WorkflowNotFoundError} if the instance does not exist
   */
  resumeWorkflow(workflowId: string): void {
    const instance = this._getInstance(workflowId);
    if (instance.status !== "paused") {
      logger.warn("Resume called on non-paused workflow", {
        instanceId: workflowId,
        status: instance.status,
      });
      return;
    }
    instance.status = "running";
    instance.updatedAt = new Date().toISOString();
    logger.info("Workflow resumed", { instanceId: workflowId });
    this.emit("workflow:resumed", instance);
  }

  /**
   * Returns the current state snapshot of a workflow instance.
   *
   * @param workflowId - Instance ID
   * @returns A readonly copy of the WorkflowInstance
   * @throws {WorkflowNotFoundError}
   */
  getWorkflowStatus(workflowId: string): Readonly<WorkflowInstance> {
    return this._getInstance(workflowId);
  }

  /**
   * Signals a running workflow to cancel gracefully.
   *
   * @param workflowId - Instance ID
   * @throws {WorkflowNotFoundError}
   */
  cancelWorkflow(workflowId: string): void {
    const instance = this._getInstance(workflowId);
    const controller = this.abortControllers.get(workflowId);
    if (controller) {
      controller.abort("Cancelled by caller");
    }
    instance.status = "cancelled";
    instance.updatedAt = new Date().toISOString();
    logger.info("Workflow cancellation requested", { instanceId: workflowId });
  }

  /**
   * Returns all workflow instances that are currently running or paused.
   */
  listActiveWorkflows(): WorkflowInstance[] {
    return Array.from(this.instances.values()).filter(
      (i) => i.status === "running" || i.status === "paused",
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Executes a single step with retry/back-off semantics and optional timeout.
   */
  private async _executeStep(
    step: OrchestratorStep,
    input: unknown,
    instance: WorkflowInstance,
    signal: AbortSignal,
  ): Promise<unknown> {
    let attempt = 0;
    const maxAttempts = step.retryable ? step.maxRetries + 1 : 1;

    while (attempt < maxAttempts) {
      if (signal.aborted) {
        throw new Error("Workflow cancelled during step execution");
      }

      const execRecord: StepExecution = {
        stepId: step.id,
        label: step.label,
        attempt,
        status: "running",
        input,
        output: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        durationMs: null,
      };
      instance.stepHistory.push(execRecord);

      const stepContext: StepContext = {
        workflowId: instance.workflowId,
        stepId: step.id,
        attempt,
        startedAt: execRecord.startedAt,
      };

      logger.debug("Step started", {
        instanceId: instance.instanceId,
        stepId: step.id,
        attempt,
      });
      this.emit("workflow:step:started", instance, step, attempt);

      const t0 = Date.now();
      try {
        let promise = step.handler(input, stepContext);
        if (step.timeoutMs != null && step.timeoutMs > 0) {
          promise = timeout(promise, step.timeoutMs, step.id);
        }
        // Race step against abort signal so cancelWorkflow() terminates immediately
        const abortRace = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("Step aborted: workflow was cancelled"));
            return;
          }
          const onAbort = (): void => {
            reject(new Error("Step aborted: workflow was cancelled"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const output = await Promise.race([promise, abortRace]);

        execRecord.status = "completed";
        execRecord.output = output;
        execRecord.completedAt = new Date().toISOString();
        execRecord.durationMs = Date.now() - t0;
        instance.updatedAt = new Date().toISOString();

        logger.debug("Step completed", {
          instanceId: instance.instanceId,
          stepId: step.id,
          durationMs: execRecord.durationMs,
        });
        this.emit("workflow:step:completed", instance, step, output);
        return output;
      } catch (err) {
        execRecord.status = "failed";
        execRecord.completedAt = new Date().toISOString();
        execRecord.durationMs = Date.now() - t0;
        execRecord.error = err instanceof Error ? err.message : String(err);

        const errStack = err instanceof Error ? err.stack : undefined;
        const workflowError: WorkflowExecutionError = {
          stepId: step.id,
          message: execRecord.error,
          ...(errStack !== undefined ? { stack: errStack } : {}),
          retryable: step.retryable && attempt < maxAttempts - 1,
          timestamp: new Date().toISOString(),
        };
        instance.errors.push(workflowError);
        instance.updatedAt = new Date().toISOString();

        logger.warn("Step failed", {
          instanceId: instance.instanceId,
          stepId: step.id,
          attempt,
          error: execRecord.error,
        });
        this.emit("workflow:step:failed", instance, step, err, attempt);

        attempt++;
        if (attempt < maxAttempts && step.retryable) {
          const delay = backoffMs(attempt);
          logger.debug("Retrying step after back-off", { stepId: step.id, delay });
          await sleep(delay);
        } else {
          throw err;
        }
      }
    }

    throw new Error(`Step "${step.id}" exhausted all retry attempts`);
  }

  /**
   * Polls until the workflow transitions out of the 'paused' state.
   */
  private async _waitForResume(
    instance: WorkflowInstance,
    signal: AbortSignal,
    timeoutMs = 5 * 60 * 1000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    logger.debug("Waiting for workflow to resume", { instanceId: instance.instanceId });
    while (instance.status === "paused") {
      if (signal.aborted) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Workflow "${instance.instanceId}" remained paused for ${timeoutMs}ms without a resume call`,
        );
      }
      await sleep(500);
    }
  }

  /** Retrieves a workflow instance or throws WorkflowNotFoundError */
  private _getInstance(instanceId: string): WorkflowInstance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new WorkflowNotFoundError(instanceId);
    }
    return instance;
  }
}
