import type { SkillName } from "../types/agent.ts";
import type { PipelineTemplate } from "../agents/registry.ts";
import { AGENT_DEPENDENCY_GRAPH } from "../agents/registry.ts";
import type { SkillRegistry } from "../agents/skill-registry.ts";
import type { DomainRegistry } from "../domain/domain-registry.ts";
import type {
  Goal,
  GoalCategory,
  GoalPhase,
  GoalPlan,
  RoutingDecision,
} from "./types.ts";

// ── Default Category → Template Mapping (marketing domain, backward compat) ─

export const GOAL_CATEGORY_TEMPLATE_MAP: Record<string, string | null> = {
  strategic: null,
  content: "Content Production",
  optimization: "Conversion Sprint",
  retention: "Retention Sprint",
  competitive: "Competitive Response",
  measurement: "SEO Cycle",
};

// ── Default Phase Blueprints (marketing domain, backward compat) ────────────

interface PhaseBlueprint {
  readonly name: string;
  readonly description: string;
}

const DEFAULT_CATEGORY_PHASE_NAMES: Record<string, readonly PhaseBlueprint[]> = {
  strategic: [
    { name: "PLAN", description: "Develop strategy and positioning" },
    { name: "MEASURE", description: "Track and validate strategic outcomes" },
  ],
  content: [
    { name: "PLAN", description: "Define content strategy" },
    { name: "CREATE", description: "Produce content assets" },
    { name: "MEASURE", description: "Audit and track content performance" },
  ],
  optimization: [
    { name: "AUDIT", description: "Assess current conversion performance" },
    { name: "CREATE", description: "Execute improvements based on audit" },
    { name: "TEST", description: "Set up experiments and tracking" },
  ],
  retention: [
    { name: "ACTIVATE", description: "Improve activation and retention flows" },
    { name: "MEASURE", description: "Test and measure retention changes" },
  ],
  competitive: [
    { name: "RESEARCH", description: "Analyze competitive landscape" },
    { name: "RESPOND", description: "Create competitive response content" },
    { name: "ADJUST", description: "Update pricing if needed" },
    { name: "MEASURE", description: "Track response effectiveness" },
  ],
  measurement: [
    { name: "MEASURE", description: "Run audits and set up tracking" },
  ],
};

// ── Goal Decomposer ──────────────────────────────────────────────────────────

export class GoalDecomposer {
  private readonly dependencyGraph: Record<SkillName, readonly SkillName[]>;
  private readonly categoryTemplateMap: Record<string, string | null>;
  private readonly categoryPhaseNames: Record<string, readonly PhaseBlueprint[]>;

  constructor(
    private readonly templates: readonly PipelineTemplate[],
    registry?: SkillRegistry,
    domainRegistry?: DomainRegistry,
  ) {
    this.dependencyGraph = registry?.dependencyGraph ?? AGENT_DEPENDENCY_GRAPH;

    // Use domain config if available, otherwise fall back to hardcoded defaults
    if (domainRegistry) {
      this.categoryTemplateMap = domainRegistry.getCategoryTemplateMap();
      const phaseNames: Record<string, readonly PhaseBlueprint[]> = {};
      for (const cat of domainRegistry.categories) {
        phaseNames[cat.name] = cat.phases.map((p) => ({
          name: p.name,
          description: p.description,
        }));
      }
      this.categoryPhaseNames = phaseNames;
    } else {
      this.categoryTemplateMap = GOAL_CATEGORY_TEMPLATE_MAP;
      this.categoryPhaseNames = DEFAULT_CATEGORY_PHASE_NAMES;
    }
  }

  /**
   * Decompose a goal into a phased plan.
   * Template-first: if a pipeline template matches the category, use it.
   * Custom-second: otherwise build phases from routing decision.
   */
  decompose(goal: Goal, routing: RoutingDecision): GoalPlan {
    const template = this.findMatchingTemplate(goal.category);

    let phases: readonly GoalPhase[];
    let templateName: string | null = null;

    if (template) {
      phases = this.templateToPhases(template);
      templateName = template.name;
    } else {
      phases = this.routingToPhases(routing, goal.category);
    }

    const estimatedTaskCount = phases.reduce(
      (sum, phase) => sum + phase.skills.length,
      0,
    );

    return {
      goalId: goal.id,
      phases,
      estimatedTaskCount,
      pipelineTemplateName: templateName,
    };
  }

  /**
   * Find the best-matching pipeline template for a goal category.
   */
  findMatchingTemplate(category: GoalCategory): PipelineTemplate | null {
    const templateName = this.categoryTemplateMap[category];
    if (!templateName) return null;
    return this.templates.find((t) => t.name === templateName) ?? null;
  }

  /**
   * Convert a PipelineTemplate into GoalPhase[].
   * Sequential steps → single-skill phase with parallel:false
   * Array steps → multi-skill phase with parallel:true
   */
  templateToPhases(template: PipelineTemplate): readonly GoalPhase[] {
    return template.steps.map((step, index) => {
      if (Array.isArray(step)) {
        const skills = step as readonly SkillName[];
        return {
          name: `PHASE_${index + 1}`,
          description: `Parallel execution: ${skills.join(", ")}`,
          skills,
          parallel: true,
          dependsOnPhase: index > 0 ? index - 1 : null,
        };
      } else {
        const skill = step as SkillName;
        return {
          name: `PHASE_${index + 1}`,
          description: `Execute ${skill}`,
          skills: [skill],
          parallel: false,
          dependsOnPhase: index > 0 ? index - 1 : null,
        };
      }
    });
  }

  /**
   * Build GoalPhase[] from a RoutingDecision when no template matches.
   */
  routingToPhases(
    routing: RoutingDecision,
    category: GoalCategory,
  ): readonly GoalPhase[] {
    const blueprints = this.categoryPhaseNames[category] ?? [];

    return routing.routes.map((route, index) => {
      const blueprint = blueprints[index] ?? {
        name: `PHASE_${index + 1}`,
        description: `${route.squad} squad work`,
      };

      return {
        name: blueprint.name,
        description: blueprint.description,
        skills: route.skills,
        parallel: this.canRunParallel(route.skills),
        dependsOnPhase: index > 0 ? index - 1 : null,
      };
    });
  }

  /**
   * Determine if skills can run in parallel.
   * Two skills can run in parallel if neither is upstream of the other.
   */
  canRunParallel(skills: readonly SkillName[]): boolean {
    if (skills.length <= 1) return true;

    for (let i = 0; i < skills.length; i++) {
      const consumers = this.dependencyGraph[skills[i]!] ?? [];
      for (let j = 0; j < skills.length; j++) {
        if (i === j) continue;
        if (consumers.includes(skills[j]!)) {
          return false;
        }
      }
    }

    return true;
  }
}
