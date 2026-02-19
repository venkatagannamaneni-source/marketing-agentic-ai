import type { SkillName } from "../types/agent.ts";
import { SKILL_SQUAD_MAP } from "../types/agent.ts";
import type { Priority, Task, TaskNext } from "../types/task.ts";
import type {
  PipelineDefinition,
  PipelineRun,
  PipelineStep,
  PipelineTrigger,
} from "../types/pipeline.ts";
import type { PipelineTemplate } from "../agents/registry.ts";
import { generateTaskId, generateRunId } from "../workspace/id.ts";
import type { Goal, GoalPlan } from "./types.ts";

// ── Pipeline Factory ─────────────────────────────────────────────────────────

export class PipelineFactory {
  constructor(private readonly templates: readonly PipelineTemplate[]) {}

  /**
   * Find a template by exact name.
   */
  findTemplate(name: string): PipelineTemplate | undefined {
    return this.templates.find((t) => t.name === name);
  }

  /**
   * Convert a PipelineTemplate into a formal PipelineDefinition.
   */
  templateToDefinition(template: PipelineTemplate): PipelineDefinition {
    const steps: PipelineStep[] = template.steps.map((step) => {
      if (Array.isArray(step)) {
        return {
          type: "parallel" as const,
          skills: step as readonly SkillName[],
        };
      }
      return { type: "sequential" as const, skill: step as SkillName };
    });

    const id = template.name.toLowerCase().replace(/\s+/g, "-");
    const trigger = parseTrigger(template.trigger);

    return {
      id,
      name: template.name,
      description: template.description,
      steps,
      defaultPriority: template.defaultPriority,
      trigger,
    };
  }

  /**
   * Convert a GoalPlan into a PipelineDefinition.
   */
  goalPlanToDefinition(plan: GoalPlan, goal: Goal): PipelineDefinition {
    const steps: PipelineStep[] = plan.phases.map((phase) => {
      if (phase.parallel && phase.skills.length > 1) {
        return { type: "parallel" as const, skills: phase.skills };
      }
      if (phase.skills.length === 1) {
        return { type: "sequential" as const, skill: phase.skills[0]! };
      }
      // Multiple skills but not parallel → break into sequential steps
      // For simplicity, treat as parallel (they'll be serialized by the executor if needed)
      return { type: "parallel" as const, skills: phase.skills };
    });

    const id = `goal-plan-${plan.goalId}`;

    return {
      id,
      name: `Plan for: ${goal.description.slice(0, 60)}`,
      description: goal.description,
      steps,
      defaultPriority: goal.priority,
      trigger: { type: "manual" },
    };
  }

  /**
   * Create a PipelineRun for a given definition.
   */
  createRun(
    definition: PipelineDefinition,
    goalId: string | null,
  ): PipelineRun {
    return {
      id: generateRunId(definition.id),
      pipelineId: definition.id,
      goalId,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: "pending",
      currentStepIndex: 0,
      taskIds: [],
    };
  }

  /**
   * Create Task objects for a given pipeline step.
   */
  createTasksForStep(
    step: PipelineStep,
    stepIndex: number,
    totalSteps: number,
    run: PipelineRun,
    goalDescription: string,
    priority: Priority,
    inputPaths: readonly string[],
  ): readonly Task[] {
    if (step.type === "review") {
      return [];
    }

    const now = new Date().toISOString();
    const isLastStep = stepIndex === totalSteps - 1;
    const nextAction: TaskNext = isLastStep
      ? { type: "director_review" }
      : { type: "pipeline_continue", pipelineId: run.id };

    const skills: readonly SkillName[] =
      step.type === "sequential" ? [step.skill] : step.skills;

    return skills.map((skill) => {
      const taskId = generateTaskId(skill);
      const squad = SKILL_SQUAD_MAP[skill];
      const outputPath = squad
        ? `outputs/${squad}/${skill}/${taskId}.md`
        : `outputs/foundation/${skill}/${taskId}.md`;

      return {
        id: taskId,
        createdAt: now,
        updatedAt: now,
        from: "director" as const,
        to: skill,
        priority,
        deadline: null,
        status: "pending" as const,
        revisionCount: 0,
        goalId: run.goalId,
        pipelineId: run.id,
        goal: goalDescription,
        inputs: [
          {
            path: "context/product-marketing-context.md",
            description: "Product context",
          },
          ...inputPaths.map((p) => ({
            path: p,
            description: "Output from previous pipeline step",
          })),
        ],
        requirements: `Complete ${skill} work as part of pipeline "${run.pipelineId}" for goal: ${goalDescription}`,
        output: {
          path: outputPath,
          format: "Markdown per SKILL.md specification",
        },
        next: nextAction,
        tags: [run.pipelineId, skill],
        metadata: { stepIndex, pipelineRunId: run.id },
      } satisfies Task;
    });
  }

  /**
   * Full pipeline instantiation from a template name.
   */
  instantiate(
    templateName: string,
    goalDescription: string,
    goalId: string | null,
    priority?: Priority,
  ): {
    definition: PipelineDefinition;
    run: PipelineRun;
    tasks: readonly Task[];
  } {
    const template = this.findTemplate(templateName);
    if (!template) {
      throw new Error(`Unknown pipeline template: "${templateName}"`);
    }

    const definition = this.templateToDefinition(template);
    const run = this.createRun(definition, goalId);
    const effectivePriority = priority ?? definition.defaultPriority;

    // Create tasks for the first step only
    const firstStep = definition.steps[0];
    const tasks = firstStep
      ? this.createTasksForStep(
          firstStep,
          0,
          definition.steps.length,
          run,
          goalDescription,
          effectivePriority,
          [],
        )
      : [];

    return { definition, run, tasks };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseTrigger(trigger: string): PipelineTrigger {
  const lower = trigger.toLowerCase();
  if (lower.includes("weekly")) {
    return { type: "schedule", cron: "0 0 * * 1" }; // Monday midnight
  }
  if (lower.includes("monthly")) {
    return { type: "schedule", cron: "0 0 1 * *" }; // 1st of month
  }
  if (lower.includes("daily")) {
    return { type: "schedule", cron: "0 6 * * *" }; // 6 AM daily
  }
  return { type: "manual" };
}
