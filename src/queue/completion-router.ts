import type { Task } from "../types/task.ts";
import type { SkillName } from "../types/agent.ts";
import { SKILL_SQUAD_MAP } from "../types/agent.ts";
import type { ExecutionResult } from "../agents/executor.ts";
import type { WorkspaceManager } from "../workspace/workspace-manager.ts";
import type { MarketingDirector } from "../director/director.ts";
import type { RoutingAction } from "./types.ts";
import { generateTaskId } from "../workspace/id.ts";
import { NULL_LOGGER } from "../observability/logger.ts";
import type { Logger } from "../observability/logger.ts";

// ── Completion Router ───────────────────────────────────────────────────────
// Routes completed tasks to their next step based on task.next.
// This is the orchestration glue that closes the Director→Queue→Executor→Director loop.

export class CompletionRouter {
  private readonly logger: Logger;

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly director: MarketingDirector,
    logger?: Logger,
  ) {
    this.logger = (logger ?? NULL_LOGGER).child({ module: "completion-router" });
  }

  /**
   * Determine what to do after a task completes execution.
   */
  async route(task: Task, result: ExecutionResult): Promise<RoutingAction> {
    this.logger.debug("router_route_started", {
      taskId: task.id,
      nextType: task.next.type,
    });

    switch (task.next.type) {
      case "agent":
        return this.routeToAgent(task, task.next.skill, result);

      case "director_review":
        return this.routeToDirectorReview(task);

      case "pipeline_continue":
        return this.routeToPipelineContinue(task);

      case "complete":
        return { type: "complete", taskId: task.id };

      default: {
        const _exhaustive: never = task.next;
        throw new Error(`Unhandled task.next.type: ${(_exhaustive as { type: string }).type}`);
      }
    }
  }

  private async routeToAgent(
    previousTask: Task,
    nextSkill: SkillName,
    result: ExecutionResult,
  ): Promise<RoutingAction> {
    const followUpTask = this.createFollowUpTask(previousTask, nextSkill, result);
    await this.workspace.writeTask(followUpTask);
    this.logger.info("router_to_agent", {
      taskId: previousTask.id,
      nextSkill,
      followUpTaskId: followUpTask.id,
    });
    return { type: "enqueue_tasks", tasks: [followUpTask] };
  }

  private async routeToDirectorReview(task: Task): Promise<RoutingAction> {
    const decision = await this.director.reviewCompletedTask(task.id);
    this.logger.info("router_to_director_review", {
      taskId: task.id,
      action: decision.action,
    });

    switch (decision.action) {
      case "approve":
      case "goal_complete":
        return { type: "complete", taskId: task.id };

      case "pipeline_next":
      case "revise":
      case "reject_reassign":
        return { type: "enqueue_tasks", tasks: decision.nextTasks };

      case "escalate_human":
        return {
          type: "dead_letter",
          taskId: task.id,
          reason: "escalated_to_human",
        };

      case "goal_iterate": {
        if (task.goalId) {
          const nextTasks = await this.director.advanceGoal(task.goalId);
          if (nextTasks === "complete") {
            return { type: "complete", taskId: task.id };
          }
          return { type: "enqueue_tasks", tasks: nextTasks };
        }
        return { type: "complete", taskId: task.id };
      }

      default: {
        const _exhaustive: never = decision.action;
        throw new Error(`Unhandled director action: ${_exhaustive as string}`);
      }
    }
  }

  private async routeToPipelineContinue(task: Task): Promise<RoutingAction> {
    if (task.goalId) {
      const nextTasks = await this.director.advanceGoal(task.goalId);
      if (nextTasks === "complete") {
        return { type: "complete", taskId: task.id };
      }
      return { type: "enqueue_tasks", tasks: nextTasks };
    }
    return { type: "complete", taskId: task.id };
  }

  private createFollowUpTask(
    previousTask: Task,
    nextSkill: SkillName,
    result: ExecutionResult,
  ): Task {
    const now = new Date().toISOString();
    const taskId = generateTaskId(nextSkill);
    const squad = SKILL_SQUAD_MAP[nextSkill];
    const outputPath = squad
      ? `outputs/${squad}/${nextSkill}/${taskId}.md`
      : `outputs/foundation/${nextSkill}/${taskId}.md`;

    return {
      id: taskId,
      createdAt: now,
      updatedAt: now,
      from: previousTask.to,
      to: nextSkill,
      priority: previousTask.priority,
      deadline: previousTask.deadline,
      status: "pending",
      revisionCount: 0,
      goalId: previousTask.goalId,
      pipelineId: previousTask.pipelineId,
      goal: previousTask.goal,
      inputs: result.outputPath
        ? [
            {
              path: result.outputPath,
              description: `Output from ${previousTask.to}`,
            },
          ]
        : [],
      requirements: `Continue pipeline work using output from ${previousTask.to}. Goal: ${previousTask.goal}`,
      output: {
        path: outputPath,
        format: "Markdown per SKILL.md specification",
      },
      next: { type: "director_review" },
      tags: [...previousTask.tags],
      metadata: {
        previousTaskId: previousTask.id,
        previousSkill: previousTask.to,
      },
    };
  }
}
