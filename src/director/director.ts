import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { SkillName } from "../types/agent.ts";
import { SKILL_SQUAD_MAP } from "../types/agent.ts";
import type { Priority, Task } from "../types/task.ts";
import type { Review } from "../types/review.ts";
import type { PipelineDefinition, PipelineRun } from "../types/pipeline.ts";
import { PIPELINE_TEMPLATES } from "../agents/registry.ts";
import type {
  Goal,
  GoalCategory,
  GoalPlan,
  GoalPhase,
  DirectorDecision,
  DirectorConfig,
  BudgetState,
  RoutingDecision,
} from "./types.ts";
import { DEFAULT_DIRECTOR_CONFIG, GOAL_CATEGORIES } from "./types.ts";
import { PRIORITIES } from "../types/task.ts";
import { WorkspaceError } from "../workspace/errors.ts";
import { DIRECTOR_SYSTEM_PROMPT } from "./system-prompt.ts";
import { GoalDecomposer } from "./goal-decomposer.ts";
import { PipelineFactory } from "./pipeline-factory.ts";
import { ReviewEngine } from "./review-engine.ts";
import { EscalationEngine } from "./escalation.ts";
import { routeGoal } from "./squad-router.ts";

// ── Goal ID Generator ────────────────────────────────────────────────────────

export function generateGoalId(): string {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `goal-${dateStr}-${hex}`;
}

// ── Goal Serialization ───────────────────────────────────────────────────────

function serializeGoal(goal: Goal): string {
  const lines = [
    "---",
    `id: ${goal.id}`,
    `category: ${goal.category}`,
    `priority: ${goal.priority}`,
    `created_at: ${goal.createdAt}`,
    `deadline: ${goal.deadline ?? "none"}`,
    `metadata: ${JSON.stringify(goal.metadata)}`,
    "---",
    "",
    `# Goal: ${goal.id}`,
    "",
    "## Description",
    "",
    goal.description,
    "",
  ];
  return lines.join("\n");
}

function deserializeGoal(markdown: string): Goal {
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error("Invalid goal file: no frontmatter");

  const fm: Record<string, string> = {};
  for (const line of fmMatch[1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }

  const bodyMatch = markdown.match(/## Description\n\n([\s\S]*?)$/);
  const description = bodyMatch ? bodyMatch[1]!.trim() : "";

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(fm.metadata ?? "{}");
  } catch {
    // ignore parse errors
  }

  if (!fm.id) throw new Error("Invalid goal file: missing id");
  if (!fm.created_at) throw new Error("Invalid goal file: missing created_at");

  const category = fm.category;
  if (
    !category ||
    !(GOAL_CATEGORIES as readonly string[]).includes(category)
  ) {
    throw new Error(`Invalid goal file: invalid category "${category}"`);
  }

  const priority = fm.priority;
  if (!priority || !(PRIORITIES as readonly string[]).includes(priority)) {
    throw new Error(`Invalid goal file: invalid priority "${priority}"`);
  }

  return {
    id: fm.id,
    description,
    category: category as GoalCategory,
    priority: priority as Priority,
    createdAt: fm.created_at,
    deadline: fm.deadline === "none" || !fm.deadline ? null : fm.deadline,
    metadata,
  };
}

// ── Goal Plan Serialization ──────────────────────────────────────────────────

function serializeGoalPlan(plan: GoalPlan): string {
  const lines = [
    "---",
    `goal_id: ${plan.goalId}`,
    `estimated_task_count: ${plan.estimatedTaskCount}`,
    `pipeline_template: ${plan.pipelineTemplateName ?? "none"}`,
    "---",
    "",
    `# Goal Plan: ${plan.goalId}`,
    "",
  ];

  for (let i = 0; i < plan.phases.length; i++) {
    const phase = plan.phases[i]!;
    lines.push(`## Phase ${i + 1}: ${phase.name}`);
    lines.push("");
    lines.push(phase.description);
    lines.push("");
    lines.push(`- **Parallel:** ${phase.parallel}`);
    lines.push(
      `- **Depends on:** ${phase.dependsOnPhase !== null ? `Phase ${phase.dependsOnPhase + 1}` : "none"}`,
    );
    lines.push(`- **Skills:** ${phase.skills.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Marketing Director ───────────────────────────────────────────────────────

export class MarketingDirector {
  private readonly config: DirectorConfig;
  private readonly goalDecomposer: GoalDecomposer;
  private readonly pipelineFactory: PipelineFactory;
  private readonly reviewEngine: ReviewEngine;
  private readonly escalationEngine: EscalationEngine;

  constructor(
    private readonly workspace: WorkspaceManager,
    config?: Partial<DirectorConfig>,
  ) {
    this.config = { ...DEFAULT_DIRECTOR_CONFIG, ...config };
    this.goalDecomposer = new GoalDecomposer(PIPELINE_TEMPLATES);
    this.pipelineFactory = new PipelineFactory(PIPELINE_TEMPLATES);
    this.reviewEngine = new ReviewEngine(this.config);
    this.escalationEngine = new EscalationEngine(this.config);
  }

  // ── Goal Management ──────────────────────────────────────────────────────

  /**
   * Create a Goal and persist it to the workspace.
   */
  async createGoal(
    description: string,
    category: GoalCategory,
    priority?: Priority,
    deadline?: string,
  ): Promise<Goal> {
    const goal: Goal = {
      id: generateGoalId(),
      description,
      category,
      priority: priority ?? this.config.defaultPriority,
      createdAt: new Date().toISOString(),
      deadline: deadline ?? null,
      metadata: {},
    };

    // Ensure goals directory exists (not part of standard workspace dirs)
    await mkdir(resolve(this.workspace.paths.root, "goals"), {
      recursive: true,
    });

    await this.workspace.writeFile(
      `goals/${goal.id}.md`,
      serializeGoal(goal),
    );

    return goal;
  }

  /**
   * Read a goal from the workspace.
   */
  async readGoal(goalId: string): Promise<Goal> {
    const content = await this.workspace.readFile(`goals/${goalId}.md`);
    return deserializeGoal(content);
  }

  /**
   * Decompose a goal into a phased GoalPlan.
   * Pure logic — does not create tasks.
   */
  decomposeGoal(goal: Goal): GoalPlan {
    const routing = this.routeGoal(goal.category);
    return this.goalDecomposer.decompose(goal, routing);
  }

  /**
   * Materialize Phase 1 tasks from a GoalPlan and write them to the workspace.
   * Also persists the plan itself.
   */
  async planGoalTasks(plan: GoalPlan, goal: Goal): Promise<readonly Task[]> {
    // Persist the plan
    await this.workspace.writeFile(
      `goals/${plan.goalId}-plan.md`,
      serializeGoalPlan(plan),
    );

    // Materialize Phase 1 tasks only
    const firstPhase = plan.phases[0];
    if (!firstPhase) return [];

    const definition = this.pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = this.pipelineFactory.createRun(definition, goal.id);

    const firstStep = definition.steps[0];
    if (!firstStep) return [];

    const tasks = this.pipelineFactory.createTasksForStep(
      firstStep,
      0,
      definition.steps.length,
      run,
      goal.description,
      goal.priority,
      [],
    );

    // Write all tasks to workspace
    for (const task of tasks) {
      await this.workspace.writeTask(task);
    }

    return tasks;
  }

  // ── Pipeline Management ──────────────────────────────────────────────────

  /**
   * Start a pipeline from a named template.
   */
  async startPipeline(
    templateName: string,
    goalDescription: string,
    priority?: Priority,
  ): Promise<{
    definition: PipelineDefinition;
    run: PipelineRun;
    tasks: readonly Task[];
  }> {
    const result = this.pipelineFactory.instantiate(
      templateName,
      goalDescription,
      null,
      priority,
    );

    // Write tasks to workspace
    for (const task of result.tasks) {
      await this.workspace.writeTask(task);
    }

    return result;
  }

  // ── Task Lifecycle ───────────────────────────────────────────────────────

  /**
   * Review a completed task and produce a DirectorDecision.
   */
  async reviewCompletedTask(taskId: string): Promise<DirectorDecision> {
    const task = await this.workspace.readTask(taskId);

    // Read the output
    let outputContent = "";
    try {
      const squad = SKILL_SQUAD_MAP[task.to];
      if (squad) {
        outputContent = await this.workspace.readOutput(
          squad,
          task.to,
          taskId,
        );
      }
    } catch (err: unknown) {
      if (err instanceof WorkspaceError && err.code === "NOT_FOUND") {
        // Output doesn't exist yet — will be flagged as empty by review engine
      } else {
        throw err;
      }
    }

    // Get existing reviews for this task (listReviews returns [] if none exist)
    const existingReviews = await this.workspace.listReviews(taskId);

    // Evaluate
    const decision = this.reviewEngine.evaluateTask(
      task,
      outputContent,
      existingReviews,
    );

    // Write the review
    if (decision.review) {
      await this.workspace.writeReview(decision.review);
    }

    // Write follow-up tasks
    for (const nextTask of decision.nextTasks) {
      await this.workspace.writeTask(nextTask);
    }

    // Update task status based on decision
    const statusMap: Record<string, string> = {
      approve: "approved",
      goal_complete: "approved",
      pipeline_next: "approved",
      revise: "revision",
      reject_reassign: "failed",
      escalate_human: "blocked",
      goal_iterate: "completed",
    };
    const newStatus = statusMap[decision.action];
    if (newStatus) {
      await this.workspace.updateTaskStatus(
        taskId,
        newStatus as Task["status"],
      );
    }

    // Append learning if present
    if (decision.learning) {
      await this.workspace.appendLearning(decision.learning);
    }

    return decision;
  }

  /**
   * Advance a goal to the next phase.
   * Returns the new tasks or "complete" if all phases are done.
   */
  async advanceGoal(
    goalId: string,
  ): Promise<readonly Task[] | "complete"> {
    // Read the goal
    const goal = await this.readGoal(goalId);

    // Read all tasks for this goal
    // Note: TaskFilter doesn't support goalId yet, so we read all and filter.
    // This is acceptable for now; a goalId filter can be added to TaskFilter
    // when workspace performance matters at scale.
    const allTasks = await this.workspace.listTasks();
    const goalTasks = allTasks.filter((t) => t.goalId === goalId);

    // Check if all current tasks are approved
    const pendingOrActive = goalTasks.filter(
      (t) =>
        t.status !== "approved" &&
        t.status !== "cancelled" &&
        t.status !== "failed",
    );

    if (pendingOrActive.length > 0) {
      // Still have active tasks — return them
      return pendingOrActive;
    }

    // All done — decompose to find the plan again and check for next phase
    const plan = this.decomposeGoal(goal);

    // Count approved tasks per skill to handle skills that appear in multiple phases.
    // We track how many approved tasks exist for each skill, then consume them
    // phase-by-phase to determine which phase is next.
    const approvedCountBySkill = new Map<string, number>();
    for (const t of goalTasks) {
      if (t.status === "approved") {
        approvedCountBySkill.set(
          t.to,
          (approvedCountBySkill.get(t.to) ?? 0) + 1,
        );
      }
    }

    // Find the first phase with insufficient approved tasks
    const consumedBySkill = new Map<string, number>();
    let nextPhaseIndex = -1;
    for (let i = 0; i < plan.phases.length; i++) {
      const phase = plan.phases[i]!;
      const allComplete = phase.skills.every((s) => {
        const consumed = consumedBySkill.get(s) ?? 0;
        const approved = approvedCountBySkill.get(s) ?? 0;
        return approved > consumed;
      });
      if (!allComplete) {
        nextPhaseIndex = i;
        break;
      }
      // Mark skills as consumed for this phase
      for (const s of phase.skills) {
        consumedBySkill.set(s, (consumedBySkill.get(s) ?? 0) + 1);
      }
    }

    if (nextPhaseIndex === -1) {
      // All phases complete
      return "complete";
    }

    // Materialize the next phase's tasks
    const nextPhase = plan.phases[nextPhaseIndex]!;
    const definition = this.pipelineFactory.goalPlanToDefinition(plan, goal);
    const run = this.pipelineFactory.createRun(definition, goalId);

    const step = definition.steps[nextPhaseIndex];
    if (!step) return "complete";

    // Collect output paths from previous tasks as inputs
    const inputPaths = goalTasks
      .filter((t) => t.status === "approved")
      .map((t) => t.output.path);

    const tasks = this.pipelineFactory.createTasksForStep(
      step,
      nextPhaseIndex,
      definition.steps.length,
      run,
      goal.description,
      goal.priority,
      inputPaths,
    );

    for (const task of tasks) {
      await this.workspace.writeTask(task);
    }

    return tasks;
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  /**
   * Route a goal category to the appropriate squad sequence.
   */
  routeGoal(category: GoalCategory): RoutingDecision {
    return routeGoal(category);
  }

  // ── Budget / Escalation ──────────────────────────────────────────────────

  /**
   * Compute current budget state.
   */
  computeBudgetState(spent: number): BudgetState {
    return this.escalationEngine.computeBudgetState(spent);
  }

  /**
   * Check if a task should execute given current budget.
   */
  shouldExecuteTask(task: Task, budgetState: BudgetState): boolean {
    return this.escalationEngine.shouldExecuteTask(task, budgetState);
  }

  /**
   * Get the Director's system prompt.
   */
  getSystemPrompt(): string {
    return DIRECTOR_SYSTEM_PROMPT;
  }
}
