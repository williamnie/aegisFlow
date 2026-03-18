import { spawn } from 'child_process';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

import { ProcessCLIAdapter } from './adapters/acp-wrapper';
import { AdapterStatus, CapabilityStatus, CLIExecutionResult } from './adapters/base';
import { loadAegisConfig } from './config';
import { ConsensusEngine } from './engine/consensus';
import { ALL_ENGINE_SLOTS, ENGINE_LABELS } from './engine-discovery';
import { localize } from './i18n';
import {
  IDEA_BRIEF_SCHEMA,
  IDEA_FOLLOW_UP_QUESTIONS_SCHEMA,
  INTEGRATION_REVIEW_SCHEMA,
  REQUIREMENT_ASSESSMENT_SCHEMA,
  REQUIREMENT_SUMMARY_SCHEMA,
  REQUIREMENT_VALIDATION_SCHEMA,
  REVIEW_SCHEMA,
  ROUNDTABLE_MINUTES_SCHEMA,
  ROUNDTABLE_PLAN_SCHEMA,
  TASK_EXECUTION_REVIEW_SCHEMA,
  TASK_GRAPH_SCHEMA,
} from './schemas';
import { ArtifactStore } from './store';
import {
  AegisConfig,
  ConsensusSummary,
  DevelopmentStrategy,
  EngineSlot,
  IdeaBrief,
  IdeaFollowUpQuestion,
  IdeaIntakeAnswers,
  IntegrationReview,
  JsonSchema,
  LocalCheckResult,
  RequirementAssessment,
  RequirementPack,
  RequirementSummaryCard,
  RequirementValidationReview,
  RequirementValidationSummary,
  ReviewVerdict,
  RoutingStagePreferenceKey,
  RoundtableMinutes,
  RoundtablePlan,
  RoundtableTurn,
  SlotResolution,
  StructuredReview,
  TaskDomain,
  TaskGraph,
  TaskNode,
  TaskReviewRecord,
  TaskRunRecord,
  WorkspaceSnapshot,
} from './types';
import { ChatUI } from './ui/chat-cli';
import {
  captureWorkspaceSnapshot,
  diffSnapshots,
  normalizeMarkdownDocument,
  nowIso,
  safeArray,
  truncate,
  unique,
} from './utils';

const ENGINE_LENSES: Record<EngineSlot, string> = {
  claude: 'architecture, boundaries, long-range tradeoffs',
  codex: 'backend implementation, data flow, testing, maintainability',
  gemini: 'frontend UX, interaction design, product polish',
};

const ENGINE_STAGE_HINTS: Record<EngineSlot, string> = {
  claude: '架构边界 / 长链路权衡',
  codex: '后端实现 / 数据流 / 测试可维护性',
  gemini: '前端体验 / 交互设计 / 产品打磨',
};

const ALL_SLOTS: EngineSlot[] = ALL_ENGINE_SLOTS;

type ReviewProgressStatus = 'queued' | 'running' | 'completed' | 'fallback' | 'skipped';

interface ReviewProgressState {
  status: ReviewProgressStatus;
  detail?: string;
  durationMs?: number;
  resolution?: SlotResolution;
}

class UserSkippedReviewError extends Error {
  constructor(public readonly slot: EngineSlot) {
    super(`${ENGINE_LABELS[slot]} review skipped by user.`);
    this.name = 'UserSkippedReviewError';
  }
}

const IDEA_FOLLOW_UP_INTENTS = new Set([
  'targetUsers',
  'constraints',
  'successCriteria',
  'goals',
  'nonGoals',
  'assumptions',
  'workflow',
  'integration',
  'delivery',
  'other',
] as const);

interface ReviewPrdSlashCommand {
  name: 'reviewprd';
  rawInput: string;
  targetFilePath: string;
}

interface ReviewDesignSlashCommand {
  name: 'reviewd';
  rawInput: string;
  targetFilePath: string;
}

type ReviewSlashCommand = ReviewPrdSlashCommand | ReviewDesignSlashCommand;

type Stage0EntryInput =
  | {
    kind: 'idea';
    rawIdea: string;
  }
  | {
    kind: 'command';
    command: ReviewSlashCommand;
  };

type ParsedSlashCommandResult =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'command'; command: ReviewSlashCommand };

const SLASH_COMMAND_ALIASES = new Map<string, ReviewSlashCommand['name']>([
  ['/reviewp', 'reviewprd'],
  ['/reviewprd', 'reviewprd'],
  ['/reivewprd', 'reviewprd'],
  ['/reviewd', 'reviewd'],
]);

const FILE_REFERENCE_PATTERN = /@(?:"([^"]+)"|'([^']+)'|(\S+))/g;

export type PipelineStartStage =
  | 'stage0'
  | 'stage0-requirement-gate'
  | 'stage1'
  | 'stage2'
  | 'stage3'
  | 'stage4'
  | 'stage4-post-design-decision'
  | 'stage5'
  | 'stage6'
  | 'stage7';

interface OrchestratorOptions {
  startStage?: PipelineStartStage;
}

interface PipelineStageDefinition {
  id: PipelineStartStage;
  label: string;
  description: string;
  aliases: string[];
  requiredArtifacts: string[];
  ownedArtifacts: string[];
  ownedPrefixes: string[];
  stageStateKeys: string[];
}

const PIPELINE_START_STAGES: PipelineStageDefinition[] = [
  {
    id: 'stage0',
    label: 'Stage 0',
    description: 'idea intake and idea brief generation',
    aliases: ['stage0', '0', 'idea', 'idea-intake', 'stage0-idea'],
    requiredArtifacts: [],
    ownedArtifacts: [
      'idea-intake.json',
      'idea-intake.md',
      'idea-brief.json',
      'idea-brief.md',
    ],
    ownedPrefixes: [],
    stageStateKeys: ['stage0-idea'],
  },
  {
    id: 'stage0-requirement-gate',
    label: 'Stage 0.5',
    description: 'requirement gate, summary, and validation',
    aliases: ['stage0.5', '0.5', 'requirement-gate', 'req-gate', 'stage0-requirement-gate'],
    requiredArtifacts: ['idea-brief.json'],
    ownedArtifacts: [
      'requirement-assessment.json',
      'requirement-assessment.md',
      'requirement-summary.json',
      'requirement-summary.md',
      'requirement-validation-summary.json',
      'requirement-validation.md',
      'requirement-pack.json',
      'requirement-pack.md',
      'requirement-clarifications.json',
      'requirement-clarifications.md',
      'requirement-check-claude.json',
      'requirement-check-claude.md',
      'requirement-check-codex.json',
      'requirement-check-codex.md',
      'requirement-check-gemini.json',
      'requirement-check-gemini.md',
    ],
    ownedPrefixes: [],
    stageStateKeys: ['stage0-requirement-gate'],
  },
  {
    id: 'stage1',
    label: 'Stage 1',
    description: 'PRD drafting and approval',
    aliases: ['stage1', '1', 'prd'],
    requiredArtifacts: ['idea-brief.json', 'requirement-pack.md'],
    ownedArtifacts: ['prd-draft.md', 'prd-final.md'],
    ownedPrefixes: [],
    stageStateKeys: ['stage1-prd'],
  },
  {
    id: 'stage2',
    label: 'Stage 2',
    description: 'technical design drafting',
    aliases: ['stage2', '2', 'design', 'tech-design', 'technical-design'],
    requiredArtifacts: ['idea-brief.json', 'prd-final.md'],
    ownedArtifacts: ['tech-design-draft.md', 'tech-design-lead.json'],
    ownedPrefixes: [],
    stageStateKeys: ['stage2-tech-design'],
  },
  {
    id: 'stage3',
    label: 'Stage 3',
    description: 'independent reviews and consensus summary',
    aliases: ['stage3', '3', 'review', 'reviews'],
    requiredArtifacts: ['prd-final.md', 'tech-design-draft.md', 'tech-design-lead.json'],
    ownedArtifacts: [
      'review-claude.json',
      'review-claude.md',
      'review-codex.json',
      'review-codex.md',
      'review-gemini.json',
      'review-gemini.md',
      'consensus-report.json',
      'consensus-report.md',
    ],
    ownedPrefixes: [],
    stageStateKeys: ['stage3-reviews'],
  },
  {
    id: 'stage4',
    label: 'Stage 4',
    description: 'roundtable, arbitration, and final design',
    aliases: ['stage4', '4', 'roundtable'],
    requiredArtifacts: ['tech-design-draft.md', 'tech-design-lead.json'],
    ownedArtifacts: [
      'roundtable-plan.json',
      'roundtable-turns.json',
      'roundtable-transcript.md',
      'roundtable-minutes.json',
      'roundtable-minutes.md',
      'tech-design-review-packet.md',
      'decision-log.json',
      'decision-log.md',
      'manual-review-handoff.md',
      'tech-design-final.md',
    ],
    ownedPrefixes: [],
    stageStateKeys: ['stage4-roundtable'],
  },
  {
    id: 'stage4-post-design-decision',
    label: 'Post-Design',
    description: 'development strategy decision',
    aliases: ['stage4.5', '4.5', 'post-design', 'strategy', 'stage4-post-design-decision'],
    requiredArtifacts: ['tech-design-final.md'],
    ownedArtifacts: ['development-strategy.json', 'development-strategy.md'],
    ownedPrefixes: [],
    stageStateKeys: ['stage4-post-design-decision'],
  },
  {
    id: 'stage5',
    label: 'Stage 5',
    description: 'task planning',
    aliases: ['stage5', '5', 'task-plan', 'taskplan', 'planning'],
    requiredArtifacts: ['tech-design-final.md', 'development-strategy.json'],
    ownedArtifacts: ['task-graph.json', 'implementation-plan.md', 'task-plan-fallback-reason.md'],
    ownedPrefixes: [],
    stageStateKeys: ['stage5-task-plan'],
  },
  {
    id: 'stage6',
    label: 'Stage 6',
    description: 'task execution',
    aliases: ['stage6', '6', 'execution', 'implement', 'implementation'],
    requiredArtifacts: ['tech-design-final.md', 'development-strategy.json', 'task-graph.json'],
    ownedArtifacts: [],
    ownedPrefixes: ['task-runs/'],
    stageStateKeys: ['stage6-execution'],
  },
  {
    id: 'stage7',
    label: 'Stage 7',
    description: 'integration review and final handoff',
    aliases: ['stage7', '7', 'integration', 'handoff'],
    requiredArtifacts: ['development-strategy.json', 'task-graph.json'],
    ownedArtifacts: ['integration-review.json', 'integration-review.md', 'delivery-summary.md', 'final-handoff.md'],
    ownedPrefixes: [],
    stageStateKeys: ['stage7-integration'],
  },
];

function normalizeStartStageToken(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-');
}

export class Orchestrator {
  private readonly store: ArtifactStore;
  private readonly config: AegisConfig;
  private readonly adapters: Record<EngineSlot, ProcessCLIAdapter>;
  private readonly initialSnapshot: WorkspaceSnapshot;
  private readonly startedAt = nowIso();
  private readonly availability = {} as Record<EngineSlot, AdapterStatus>;
  private readonly interactiveAvailability = {} as Record<EngineSlot, CapabilityStatus>;
  private readonly unhealthySlots = new Set<EngineSlot>();
  private readonly interactiveDowngradeNotified = new Set<EngineSlot>();
  private readonly startStage?: PipelineStartStage;

  constructor(sessionId?: string, options: OrchestratorOptions = {}) {
    this.store = new ArtifactStore(sessionId);
    this.config = loadAegisConfig();
    this.startStage = options.startStage;
    this.adapters = {
      claude: new ProcessCLIAdapter(
        'claude',
        ENGINE_LABELS.claude,
        this.config.engines.claude,
        this.config.dryRun,
        this.config.timeouts.modelExecutionMs,
      ),
      codex: new ProcessCLIAdapter(
        'codex',
        ENGINE_LABELS.codex,
        this.config.engines.codex,
        this.config.dryRun,
        this.config.timeouts.modelExecutionMs,
      ),
      gemini: new ProcessCLIAdapter(
        'gemini',
        ENGINE_LABELS.gemini,
        this.config.engines.gemini,
        this.config.dryRun,
        this.config.timeouts.modelExecutionMs,
      ),
    };
    this.initialSnapshot = captureWorkspaceSnapshot(process.cwd(), this.startedAt);
  }

  public static parseStartStage(value: string): PipelineStartStage {
    const normalized = normalizeStartStageToken(value);
    const match = PIPELINE_START_STAGES.find(stage => stage.aliases.includes(normalized));

    if (!match) {
      throw new Error(
        `Unknown stage "${value}". Valid values: ${PIPELINE_START_STAGES.map(stage => stage.aliases[0]).join(', ')}`,
      );
    }

    return match.id;
  }

  public static getStartStageHelpLines(): string[] {
    return PIPELINE_START_STAGES.map(stage => {
      const aliases = stage.aliases.slice(1, 3).join(', ');
      return `  ${stage.aliases[0]}${aliases ? ` (${aliases})` : ''}: ${stage.description}`;
    });
  }

  async run() {
    await ChatUI.startSession(`AegisFlow Started | Session: ${this.store.getSessionId()}`);
    await this.initializeEnvironment();

    const startStage = this.startStage || 'stage0';
    if (this.startStage) {
      this.prepareResumeFromStage(this.startStage);
    }

    const startIndex = this.getStartStageIndex(startStage);

    if (this.shouldRunStage(startIndex, 'stage0')) {
      const earlyExitMessage = await this.stage0Idea();
      if (earlyExitMessage) {
        await ChatUI.endSession(earlyExitMessage);
        return;
      }
    }
    if (this.shouldRunStage(startIndex, 'stage0-requirement-gate')) {
      await this.stage0RequirementGate();
    }
    if (this.shouldRunStage(startIndex, 'stage1')) {
      await this.stage1PRD();
    }
    if (this.shouldRunStage(startIndex, 'stage2')) {
      await this.stage2TechDesign();
    }

    let reviews: StructuredReview[] = [];
    if (this.shouldRunStage(startIndex, 'stage3')) {
      reviews = await this.stage3Reviews();
    } else if (this.shouldRunStage(startIndex, 'stage4')) {
      reviews = this.requireExistingReviewsForRoundtable();
    }

    if (this.shouldRunStage(startIndex, 'stage4')) {
      const roundtableOutcome = await this.stage4Roundtable(reviews);
      if (roundtableOutcome.pausedForManualReview) {
        await ChatUI.endSession(
          `Paused for manual review. PRD/design outputs stay in ${this.store.getWorkspaceDir()} and the session archive is saved in ${this.store.getSessionDir()}`,
        );
        return;
      }
    }

    let developmentStrategy: DevelopmentStrategy;
    if (this.shouldRunStage(startIndex, 'stage4-post-design-decision')) {
      developmentStrategy = await this.stagePostDesignDecision();
    } else {
      developmentStrategy = this.mustReadDevelopmentStrategyForExecution(startStage);
    }

    if (developmentStrategy.action === 'stop_after_design') {
      await ChatUI.endSession(
        `Technical design completed. Development was not started. PRD/design outputs stay in ${this.store.getWorkspaceDir()} and the session archive is saved in ${this.store.getSessionDir()}`,
      );
      return;
    }

    let taskGraph: TaskGraph;
    if (this.shouldRunStage(startIndex, 'stage5')) {
      taskGraph = await this.stage5TaskPlan(developmentStrategy);
    } else {
      taskGraph = this.mustReadJson<TaskGraph>('task-graph.json');
    }

    if (this.shouldRunStage(startIndex, 'stage6')) {
      await this.stage6Execution(taskGraph, developmentStrategy);
    }
    if (this.shouldRunStage(startIndex, 'stage7')) {
      await this.stage7Integration(taskGraph, developmentStrategy);
    }

    await ChatUI.endSession(
      `All stages completed. PRD/design outputs stay in ${this.store.getWorkspaceDir()} and the session archive is saved in ${this.store.getSessionDir()}`,
    );
  }

  private prepareResumeFromStage(startStage: PipelineStartStage) {
    this.validateResumeFromStage(startStage);
    const invalidation = this.invalidateFromStage(startStage);
    const stage = this.getStageDefinition(startStage);

    ChatUI.info(
      'Resume From Stage',
      [
        `起点：${stage.label} (${stage.aliases[0]})`,
        `说明：${stage.description}`,
        `已清理产物：${invalidation.deletedArtifacts}`,
        `已清理前缀：${invalidation.deletedPrefixes}`,
        `已重置阶段状态：${invalidation.clearedStageStates}`,
      ].join('\n'),
    );
  }

  private validateResumeFromStage(startStage: PipelineStartStage) {
    const stage = this.getStageDefinition(startStage);
    const missingArtifacts = stage.requiredArtifacts.filter(artifact => !this.store.exists(artifact));

    if (missingArtifacts.length > 0) {
      throw new Error(
        [
          `Cannot resume from ${stage.aliases[0]}. Missing required artifacts:`,
          ...missingArtifacts.map(artifact => `- ${artifact}`),
          `Try rerunning from ${this.previousStageAlias(startStage)} instead.`,
        ].join('\n'),
      );
    }

    if (startStage === 'stage4' && this.loadExistingReviews().length === 0) {
      throw new Error(`Cannot resume from ${stage.aliases[0]}. No saved review artifacts were found. Try rerunning from stage3 instead.`);
    }

    if (['stage5', 'stage6', 'stage7'].includes(startStage)) {
      this.mustReadDevelopmentStrategyForExecution(startStage);
    }
  }

  private invalidateFromStage(startStage: PipelineStartStage): {
    deletedArtifacts: number;
    deletedPrefixes: number;
    clearedStageStates: number;
  } {
    const startIndex = this.getStartStageIndex(startStage);
    const stageDefinitions = PIPELINE_START_STAGES.slice(startIndex);
    const deletedArtifacts = new Set<string>();
    let deletedPrefixEntries = 0;

    for (const stage of stageDefinitions) {
      for (const artifact of stage.ownedArtifacts) {
        if (this.store.deleteArtifact(artifact)) {
          deletedArtifacts.add(artifact);
        }
      }

      for (const prefix of stage.ownedPrefixes) {
        const removed = this.store.deleteArtifactsByPrefix(prefix);
        deletedPrefixEntries += removed.length;
        for (const artifact of removed) {
          deletedArtifacts.add(artifact);
        }
      }
    }

    if (this.getStartStageIndex(startStage) < this.getStartStageIndex('stage4') && this.store.deleteArtifact('manual-review-feedback.md')) {
      deletedArtifacts.add('manual-review-feedback.md');
    }

    const stageStates = unique(stageDefinitions.flatMap(stage => stage.stageStateKeys));
    this.store.clearStages(stageStates);

    return {
      deletedArtifacts: deletedArtifacts.size,
      deletedPrefixes: deletedPrefixEntries,
      clearedStageStates: stageStates.length,
    };
  }

  private getStageDefinition(stageId: PipelineStartStage): PipelineStageDefinition {
    const stage = PIPELINE_START_STAGES.find(item => item.id === stageId);
    if (!stage) {
      throw new Error(`Unknown pipeline stage: ${stageId}`);
    }
    return stage;
  }

  private getStartStageIndex(stageId: PipelineStartStage): number {
    const index = PIPELINE_START_STAGES.findIndex(stage => stage.id === stageId);
    if (index === -1) {
      throw new Error(`Unknown pipeline stage index: ${stageId}`);
    }
    return index;
  }

  private shouldRunStage(startIndex: number, targetStage: PipelineStartStage): boolean {
    return startIndex <= this.getStartStageIndex(targetStage);
  }

  private previousStageAlias(stageId: PipelineStartStage): string {
    const index = this.getStartStageIndex(stageId);
    if (index <= 0) {
      return PIPELINE_START_STAGES[0].aliases[0];
    }
    return PIPELINE_START_STAGES[index - 1].aliases[0];
  }

  private requireExistingReviewsForRoundtable(): StructuredReview[] {
    const reviews = this.loadExistingReviews();
    if (reviews.length === 0) {
      throw new Error('No saved reviews were found for the roundtable stage. Re-run from stage3 first.');
    }
    return reviews;
  }

  private mustReadDevelopmentStrategyForExecution(startStage: PipelineStartStage): DevelopmentStrategy {
    const strategy = this.mustReadJson<DevelopmentStrategy>('development-strategy.json');
    if (strategy.action !== 'start_development') {
      throw new Error(
        `Cannot resume from ${this.getStageDefinition(startStage).aliases[0]} because the saved strategy stops after design. Re-run from strategy instead.`,
      );
    }
    return strategy;
  }

  private async initializeEnvironment() {
    for (const slot of ALL_SLOTS) {
      this.availability[slot] = await this.adapters[slot].checkAvailability();
      this.interactiveAvailability[slot] = await this.adapters[slot].checkInteractiveSessionAvailability();
    }

    const lines = ALL_SLOTS.map(slot => {
      const status = this.availability[slot];
      const interactiveStatus = this.interactiveAvailability[slot];
      if (status.available) {
        return [
          `- ${ENGINE_LABELS[slot]}: available via \`${status.command}\``,
          interactiveStatus?.available
            ? this.copy('实时任务会话可用', 'live task session available')
            : this.copy(
              `实时任务会话将自动降级（${interactiveStatus?.reason || 'interactive PTY unavailable'})`,
              `live task session will auto-downgrade (${interactiveStatus?.reason || 'interactive PTY unavailable'})`,
            ),
        ].join(' | ');
      }
      return `- ${ENGINE_LABELS[slot]}: unavailable (${status.reason})`;
    });

    this.store.saveJson('engine-availability.json', this.availability);
    this.store.saveJson('engine-capabilities.json', this.interactiveAvailability);
    this.store.saveJson('session-config.json', this.config);
    ChatUI.info('Engine Availability', lines.join('\n'));
  }

  private async stage0Idea(): Promise<string | null> {
    if (this.store.exists('idea-brief.md') && this.store.exists('idea-brief.json')) {
      this.store.markStage('stage0-idea', 'completed', 'Recovered existing idea brief');
      return null;
    }

    ChatUI.stage('Stage 0', [
      '输入提供者：用户',
      this.formatSlotPreference('需求整理候选', this.stageSlotPreference('idea')),
      '输出：结构化 Idea Brief',
      this.copy(
        '快捷命令：输入 `/reviewp @prd.md` 或 `/reviewd @design.md` 可直接评审当前本地文档。',
        'Shortcuts: enter `/reviewp @prd.md` or `/reviewd @design.md` to review an existing local document directly.',
      ),
    ]);
    const entry = await this.promptStage0Entry();
    if (entry.kind === 'command') {
      if (entry.command.name === 'reviewprd') {
        return this.runReviewPrdCommand(entry.command);
      }
      return this.runReviewDesignCommand(entry.command);
    }

    this.store.markStage('stage0-idea', 'running');
    const intake = await this.collectIdeaIntake(entry.rawIdea);
    this.store.saveJson('idea-intake.json', intake);
    this.store.saveArtifact('idea-intake.md', ChatUI.formatIdeaIntakePreview(intake.rawIdea, intake.followUps));

    const prompt = [
      'You are AegisFlow\'s requirement analyst.',
      'Turn the user input into a concise structured idea brief.',
      'Use the raw idea and the follow-up Q&A together.',
      'If information is still missing, keep assumptions explicit and put unresolved items in followUps instead of inventing facts.',
      'Return JSON only and keep scope realistic for an end-to-end MVP.',
      '',
      `Raw idea: ${intake.rawIdea}`,
      'Follow-up answers:',
      ...intake.followUps.map(item => `- [${item.intent}] ${item.message}: ${item.answer}`),
    ].join('\n');

    let brief: IdeaBrief;

    try {
      const result = await this.runWithLoading(
        {
          start: this.copy('正在整理你的想法并生成结构化摘要...', 'Structuring your idea into an MVP brief...'),
          success: this.copy('结构化摘要已生成', 'Structured idea brief generated'),
          failure: this.copy('结构化摘要生成失败，将改用本地兜底摘要', 'Structured idea brief failed; falling back to a local summary'),
        },
        () => this.runJsonWithPreferredSlots<IdeaBrief>(
          this.stageSlotPreference('idea'),
          prompt,
          IDEA_BRIEF_SCHEMA,
        ),
      );
      brief = result.parsed;
      ChatUI.info('Idea Routing', this.formatRoutedExecution('需求整理', result.resolution, '需求澄清 / 结构化摘要'));
    } catch (error) {
      this.reportModelFallback('Idea Routing', '需求整理：模型执行失败，已切换为本地兜底摘要生成 Idea Brief。', error);
      brief = this.buildIdeaBriefFromIntake(intake);
    }

    this.store.saveJson('idea-brief.json', brief);
    this.store.saveArtifact('idea-brief.md', ConsensusEngine.renderIdeaBriefMarkdown(brief, this.config.language));
    this.store.markStage('stage0-idea', 'completed', 'Idea brief generated');
    return null;
  }

  private async stage0RequirementGate() {
    this.store.markStage('stage0-requirement-gate', 'running');

    if (this.store.exists('requirement-pack.json') && this.store.exists('requirement-pack.md')) {
      this.store.markStage('stage0-requirement-gate', 'completed', 'Recovered approved requirement pack');
      return;
    }

    const brief = this.mustReadJson<IdeaBrief>('idea-brief.json');
    const leadSlot = this.selectDesignLead(brief);
    const userClarifications = this.store.readJson<string[]>('requirement-clarifications.json') || [];

    ChatUI.stage('Stage 0.5', [
      `需求门禁主 Agent：${ENGINE_LABELS[leadSlot]}`,
      '职责：先判断需求是否足够清晰；复杂需求再引入其他 Agent 校验。',
      '输出：需求判断、需求总结、复杂需求校验、Requirement Pack',
    ]);

    while (true) {
      const assessment = await this.assessRequirement(brief, userClarifications, leadSlot);
      this.store.saveJson('requirement-assessment.json', assessment);
      this.store.saveArtifact('requirement-assessment.md', this.renderRequirementAssessmentMarkdown(assessment, leadSlot));

      ChatUI.info(
        'Requirement Gate',
        [
          `主 Agent：${ENGINE_LABELS[leadSlot]}`,
          `复杂度：${this.formatRequirementComplexity(assessment.complexity)}`,
          `清晰度：${this.formatRequirementClarity(assessment.clarity)}`,
          `下一步：${this.formatRequirementNextStep(assessment.nextStep)}`,
          `判断：${assessment.summary}`,
        ].join('\n'),
      );

      let summaryCard: RequirementSummaryCard | undefined;
      let summaryApproved = false;
      let validationReviews: RequirementValidationReview[] = [];
      let validationSummary: RequirementValidationSummary | undefined;

      if (assessment.shouldConfirmSummary) {
        summaryCard = await this.generateRequirementSummary(brief, assessment, userClarifications, leadSlot);
        this.store.saveJson('requirement-summary.json', summaryCard);
        this.store.saveArtifact('requirement-summary.md', this.renderRequirementSummaryMarkdown(summaryCard));

        const requirementSummaryPath = this.store.getArtifactPath('requirement-summary.md');
        ChatUI.showArtifact(
          'Requirement Summary Preview',
          truncate(this.renderRequirementSummaryMarkdown(summaryCard), 1200),
          requirementSummaryPath,
        );
        await ChatUI.inspectArtifact('Requirement Summary', requirementSummaryPath);

        const approved = await ChatUI.showApproval('需求总结');
        this.store.appendArtifact(
          'approval-log.md',
          `[${nowIso()}] Requirement summary ${approved ? 'approved' : 'sent back for revision'}\n`,
        );

        if (!approved) {
          const revisionRequest = await ChatUI.askRevisionRequest('需求总结');
          userClarifications.push(`需求总结修订：${revisionRequest}`);
          this.saveRequirementClarifications(userClarifications);
          this.store.appendArtifact(
            'approval-log.md',
            `[${nowIso()}] Requirement summary revision note: ${revisionRequest}\n`,
          );
          continue;
        }

        summaryApproved = true;
      }

      if (assessment.shouldDelegateValidation) {
        validationReviews = await this.runRequirementValidation(brief, assessment, summaryCard, userClarifications, leadSlot);
        validationSummary = this.summarizeRequirementValidation(validationReviews, assessment);
        this.store.saveJson('requirement-validation-summary.json', validationSummary);
        this.store.saveArtifact(
          'requirement-validation.md',
          this.renderRequirementValidationSummaryMarkdown(validationSummary, validationReviews),
        );

        const requirementValidationPath = this.store.getArtifactPath('requirement-validation.md');
        ChatUI.showArtifact(
          'Requirement Validation Preview',
          truncate(this.renderRequirementValidationSummaryMarkdown(validationSummary, validationReviews), 1200),
          requirementValidationPath,
        );
        await ChatUI.inspectArtifact('Requirement Validation', requirementValidationPath);

        if (!validationSummary.proceedToPrd) {
          const approved = await ChatUI.showApproval('需求校验结果');
          this.store.appendArtifact(
            'approval-log.md',
            `[${nowIso()}] Requirement validation ${approved ? 'accepted for PRD' : 'sent back for clarification'}\n`,
          );

          if (!approved) {
            const revisionRequest = await ChatUI.askRevisionRequest('需求方向');
            userClarifications.push(`复杂需求补充澄清：${revisionRequest}`);
            this.saveRequirementClarifications(userClarifications);
            this.store.appendArtifact(
              'approval-log.md',
              `[${nowIso()}] Requirement validation revision note: ${revisionRequest}\n`,
            );
            continue;
          }
        } else {
          ChatUI.info('Requirement Validation', '复杂需求校验通过，继续进入 PRD。');
          this.store.appendArtifact('approval-log.md', `[${nowIso()}] Requirement validation passed\n`);
        }
      }

      const requirementPack: RequirementPack = {
        leadSlot,
        leadLabel: ENGINE_LABELS[leadSlot],
        approvedAt: nowIso(),
        brief,
        assessment,
        ...(summaryCard ? { summaryCard } : {}),
        summaryApproved,
        validationRequired: assessment.shouldDelegateValidation,
        validationReviews,
        ...(validationSummary ? { validationSummary } : {}),
        userClarifications,
      };

      this.store.saveJson('requirement-pack.json', requirementPack);
      this.store.saveArtifact('requirement-pack.md', this.renderRequirementPackMarkdown(requirementPack));
      this.store.markStage('stage0-requirement-gate', 'completed', 'Requirement gate completed');
      return;
    }
  }

  private async promptStage0Entry(): Promise<Stage0EntryInput> {
    while (true) {
      const rawInput = await ChatUI.askIdeaSeed();
      const parsed = this.parseInitialSlashCommand(rawInput);

      if (parsed.kind === 'none') {
        return {
          kind: 'idea',
          rawIdea: rawInput,
        };
      }

      if (parsed.kind === 'command') {
        return {
          kind: 'command',
          command: parsed.command,
        };
      }

      ChatUI.info('Slash Command', parsed.message);
    }
  }

  private parseInitialSlashCommand(rawInput: string): ParsedSlashCommandResult {
    const trimmed = rawInput.trim();
    if (!trimmed.startsWith('/')) {
      return { kind: 'none' };
    }

    const match = trimmed.match(/^(\/\S+)(?:\s+(.*))?$/);
    const rawCommand = (match?.[1] || trimmed).toLowerCase();
    const remainder = match?.[2] || '';
    const commandName = SLASH_COMMAND_ALIASES.get(rawCommand);

    if (!commandName) {
      return {
        kind: 'error',
        message: this.copy(
          `未知命令：${rawCommand}\n\n当前支持：\n- \`/reviewp @prd.md\`：直接评审本地 PRD 文件\n- \`/reviewd @design.md\`：直接评审本地技术设计文件`,
          `Unknown command: ${rawCommand}\n\nCurrently supported:\n- \`/reviewp @prd.md\`: review a local PRD file directly\n- \`/reviewd @design.md\`: review a local technical design file directly`,
        ),
      };
    }

    return this.parseLocalReviewSlashCommand(commandName, trimmed, remainder);
  }

  private parseLocalReviewSlashCommand(
    commandName: ReviewSlashCommand['name'],
    rawInput: string,
    remainder: string,
  ): ParsedSlashCommandResult {
    const fileReferences = this.extractLocalFileReferences(remainder);
    const fileTypeLabel = commandName === 'reviewprd' ? 'PRD' : this.copy('技术设计', 'technical design');
    const displayCommand = commandName === 'reviewprd' ? '/reviewp' : '/reviewd';
    const example = commandName === 'reviewprd' ? '/reviewp @prd.md' : '/reviewd @design.md';
    const quotedExample =
      commandName === 'reviewprd'
        ? '/reviewp @"docs/my prd.md"'
        : '/reviewd @"docs/my design.md"';

    if (fileReferences.length === 0) {
      return {
        kind: 'error',
        message: this.copy(
          `\`${displayCommand}\` 需要一个 \`@文件路径\`。\n示例：\`${example}\`\n如果路径里有空格，请写成：\`${quotedExample}\`。`,
          `\`${displayCommand}\` requires one \`@file-path\`.\nExample: \`${example}\`\nIf the path contains spaces, use: \`${quotedExample}\`.`,
        ),
      };
    }

    if (fileReferences.length > 1) {
      return {
        kind: 'error',
        message: this.copy(
          `\`${displayCommand}\` 当前一次只支持评审一个文件，请只保留一个 \`@文件路径\`。`,
          `\`${displayCommand}\` currently supports reviewing one file at a time. Please keep a single \`@file-path\`.`,
        ),
      };
    }

    try {
      const targetFilePath = this.resolveLocalFileReference(fileReferences[0]);
      const content = fs.readFileSync(targetFilePath, 'utf-8');
      if (!content.trim()) {
        return {
          kind: 'error',
          message: this.copy(
            `目标文件是空的，无法评审：${targetFilePath}`,
            `The target file is empty and cannot be reviewed: ${targetFilePath}`,
          ),
        };
      }

      return {
        kind: 'command',
        command: {
          name: commandName,
          rawInput,
          targetFilePath,
        } as ReviewSlashCommand,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: 'error',
        message: this.copy(
          `无法解析 ${fileTypeLabel} 文件引用：${message}`,
          `Could not resolve the ${fileTypeLabel} file reference: ${message}`,
        ),
      };
    }
  }

  private extractLocalFileReferences(input: string): string[] {
    return [...input.matchAll(FILE_REFERENCE_PATTERN)]
      .map(match => match[1] || match[2] || match[3] || '')
      .map(item => item.trim())
      .filter(Boolean);
  }

  private resolveLocalFileReference(fileReference: string): string {
    const normalizedReference = fileReference.trim();
    const resolvedPath = path.isAbsolute(normalizedReference)
      ? path.resolve(normalizedReference)
      : path.resolve(process.cwd(), normalizedReference);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(this.copy(`文件不存在：${resolvedPath}`, `File does not exist: ${resolvedPath}`));
    }

    if (!fs.statSync(resolvedPath).isFile()) {
      throw new Error(this.copy(`目标不是文件：${resolvedPath}`, `Target is not a file: ${resolvedPath}`));
    }

    return resolvedPath;
  }

  private async collectIdeaIntake(rawIdea: string): Promise<IdeaIntakeAnswers> {
    let questions: IdeaFollowUpQuestion[] = [];

    try {
      const result = await this.runWithLoading(
        {
          start: this.copy('正在分析你的想法，并准备最少必要的补充问题...', 'Analyzing your idea and preparing the minimum follow-up questions...'),
          success: this.copy('补充问题已准备好', 'Follow-up questions are ready'),
          failure: this.copy('补充问题生成失败，将改用本地启发式问题', 'Follow-up generation failed; falling back to heuristic questions'),
        },
        () => this.runJsonWithPreferredSlots<{ questions: IdeaFollowUpQuestion[] }>(
          this.stageSlotPreference('idea'),
          [
            'You are AegisFlow\'s intake strategist.',
            'The user provided an initial project idea. Ask only the minimum follow-up questions needed to scope a realistic MVP.',
            'Return JSON only.',
            'Rules:',
            '- Return 2 to 4 questions.',
            '- Do not repeat or paraphrase the raw idea as a question.',
            '- Avoid generic questions when the raw idea already implies the answer.',
            '- Prioritize questions whose answers would materially change scope, delivery format, integrations, target users, or success criteria.',
            '- Each question should be answerable in 1 to 3 short sentences.',
            '- Keep message and placeholder concrete and practical.',
            '- Use short kebab-case ids.',
            '- Only use these intent values: targetUsers, constraints, successCriteria, goals, nonGoals, assumptions, workflow, integration, delivery, other.',
            '',
            `Raw idea: ${rawIdea}`,
          ].join('\n'),
          IDEA_FOLLOW_UP_QUESTIONS_SCHEMA,
        ),
      );
      questions = this.normalizeIdeaFollowUpQuestions(result.parsed.questions);
      ChatUI.info('Idea Intake Routing', this.formatRoutedExecution('动态补问', result.resolution, '最小必要澄清问题生成'));
    } catch (error) {
      this.reportModelFallback('Idea Intake Routing', '动态补问：模型执行失败，已切换为本地启发式问题集。', error);
    }

    questions = this.completeIdeaFollowUpQuestions(rawIdea, questions);
    const followUps = questions.length > 0
      ? await ChatUI.askIdeaFollowUps(questions)
      : await ChatUI.askIdeaFallbackDetails();

    return {
      rawIdea,
      followUps,
    };
  }

  private completeIdeaFollowUpQuestions(rawIdea: string, questions: IdeaFollowUpQuestion[]): IdeaFollowUpQuestion[] {
    const merged = this.normalizeIdeaFollowUpQuestions([
      ...questions,
      ...this.buildHeuristicIdeaFollowUpQuestions(rawIdea),
    ]);

    return merged.slice(0, 4);
  }

  private buildHeuristicIdeaFollowUpQuestions(rawIdea: string): IdeaFollowUpQuestion[] {
    const haystack = rawIdea.toLowerCase();
    const specialized: IdeaFollowUpQuestion[] = [];

    if (/(agent|workflow|pipeline|automation|orchestr|生成|自动化|编排|协作|审批|review|分析流程)/.test(haystack)) {
      specialized.push({
        id: 'core-workflow',
        intent: 'workflow',
        message: '这个需求里最关键的核心流程是什么？从输入到产出大概经过哪几步？',
        placeholder: '例如：输入需求 -> 生成 PRD -> 人审 -> 生成代码 -> 跑测试',
        required: true,
      });
    }

    if (/(api|github|gitlab|slack|notion|飞书|企微|企业微信|wechat|payment|支付|db|database|数据库|邮件|email|文件系统)/.test(haystack)) {
      specialized.push({
        id: 'integration-scope',
        intent: 'integration',
        message: '它需要连接哪些外部系统、数据源或仓库？哪些是 MVP 必须接入的？',
        placeholder: '例如：只接 GitHub PR 和本地 Markdown，不接 Notion',
        required: true,
      });
    }

    if (/(web|网站|页面|landing|dashboard|app|mobile|ios|android|小程序|cli|terminal|命令行|bot|机器人|plugin|插件|extension|sdk)/.test(haystack)) {
      specialized.push({
        id: 'delivery-form',
        intent: 'delivery',
        message: '你希望这个东西最终以什么形态交付？首个版本最核心的入口是什么？',
        placeholder: '例如：一个 CLI 命令；用户通过终端输入需求后直接产出结果',
        required: true,
      });
    }

    return this.normalizeIdeaFollowUpQuestions([
      {
        id: 'target-users',
        intent: 'targetUsers',
        message: '这个项目主要给谁用？最先服务的那类用户是谁？',
        placeholder: '例如：独立开发者 / 3-5 人产品工程小组',
        required: true,
      },
      ...specialized.slice(0, 1),
      {
        id: 'constraints',
        intent: 'constraints',
        message: '有没有关键约束、明确不做的范围，或必须遵守的技术边界？',
        placeholder: '例如：只做本地 CLI；不做多人实时协作；今晚要跑通 MVP',
        required: true,
      },
      {
        id: 'success-criteria',
        intent: 'successCriteria',
        message: '你怎么判断这次交付算成功？最好给出 1-3 个可验证结果。',
        placeholder: '例如：能从需求生成 PRD 和任务清单，并真实改动仓库文件',
        required: true,
      },
      ...specialized.slice(1),
    ]);
  }

  private normalizeIdeaFollowUpQuestions(questions: IdeaFollowUpQuestion[]): IdeaFollowUpQuestion[] {
    const seen = new Set<string>();

    return questions
      .map((question, index) => {
        const intent = IDEA_FOLLOW_UP_INTENTS.has(question.intent) ? question.intent : 'other';
        const message = typeof question.message === 'string' ? question.message.trim() : '';
        const placeholder =
          typeof question.placeholder === 'string' && question.placeholder.trim()
            ? question.placeholder.trim()
            : '例如：请用 1-2 句话说明';

        return {
          id: this.slugifyIdeaQuestionId(question.id, index),
          intent,
          message,
          placeholder,
          required: question.required !== false,
        } as IdeaFollowUpQuestion;
      })
      .filter(question => question.message.length > 0)
      .filter(question => {
        const key = `${question.intent}:${question.message.toLowerCase()}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  }

  private slugifyIdeaQuestionId(value: string | undefined, index: number): string {
    const normalized = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return normalized || `idea-question-${index + 1}`;
  }

  private buildIdeaBriefFromIntake(intake: IdeaIntakeAnswers): IdeaBrief {
    const targetUserAnswer = intake.followUps.find(item => item.intent === 'targetUsers')?.answer.trim();
    const goals = unique([
      intake.rawIdea.trim(),
      ...intake.followUps
        .filter(item => item.intent === 'goals' || item.intent === 'workflow')
        .map(item => item.answer.trim()),
    ]).filter(Boolean);
    const constraints = unique([
      ...intake.followUps
        .filter(item => item.intent === 'constraints')
        .flatMap(item => this.splitIdeaAnswer(item.answer)),
      ...intake.followUps
        .filter(item => item.intent === 'integration')
        .map(item => `集成范围：${item.answer.trim()}`),
      ...intake.followUps
        .filter(item => item.intent === 'delivery')
        .map(item => `交付形态：${item.answer.trim()}`),
    ]).filter(Boolean);
    const nonGoals = unique(
      intake.followUps
        .filter(item => item.intent === 'nonGoals')
        .flatMap(item => this.splitIdeaAnswer(item.answer)),
    ).filter(Boolean);
    const successCriteria = unique([
      ...intake.followUps
        .filter(item => item.intent === 'successCriteria')
        .flatMap(item => this.splitIdeaAnswer(item.answer)),
    ]).filter(Boolean);
    const assumptions = unique([
      ...intake.followUps
        .filter(item => item.intent === 'assumptions')
        .flatMap(item => this.splitIdeaAnswer(item.answer)),
      intake.followUps.some(item => item.intent === 'workflow')
        ? '用户希望先跑通核心工作流，再逐步扩展次要能力。'
        : '用户希望先完成可验证的 MVP，而不是一次性做成完整平台。',
    ]).filter(Boolean);
    const followUps = unique([
      ...intake.followUps
        .filter(item => item.intent === 'other')
        .flatMap(item => this.splitIdeaAnswer(item.answer)),
      !targetUserAnswer ? '需要进一步确认首要目标用户。' : '',
      constraints.length === 0 ? '需要进一步明确关键约束、边界和不做项。' : '',
      successCriteria.length === 0 ? '需要进一步明确可验证的成功标准。' : '',
    ]).filter(Boolean);

    return {
      rawIdea: intake.rawIdea,
      targetUsers: targetUserAnswer || '待在 PRD 阶段进一步确认',
      goals: goals.length > 0 ? goals : [intake.rawIdea],
      constraints: constraints.length > 0 ? constraints : ['暂未明确，需要在 PRD 审批阶段继续收敛'],
      nonGoals: nonGoals.length > 0 ? nonGoals : ['暂不扩展到需求中未明确提出的复杂平台能力'],
      successCriteria: successCriteria.length > 0 ? successCriteria : ['交付可运行的 MVP，并覆盖最关键的核心流程'],
      assumptions,
      followUps,
    };
  }

  private splitIdeaAnswer(value: string): string[] {
    return value
      .split(/\r?\n|[;；]|(?<=\S)，|(?<=\S),/)
      .map(item => item.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  }

  private async assessRequirement(
    brief: IdeaBrief,
    userClarifications: string[],
    leadSlot: EngineSlot,
  ): Promise<RequirementAssessment> {
    const prompt = [
      'You are the lead requirement gatekeeper before PRD generation.',
      'Decide whether the current requirement can directly become a PRD, needs a short requirement playback for user confirmation, or needs extra multi-agent validation first.',
      'Return JSON only.',
      'Rules:',
      '- complexity=low only when scope is narrow, single-workflow, low-risk, and unlikely to hide the true user need.',
      '- complexity=high when the requirement spans multiple workflows, stakeholders, integrations, or the cost of misunderstanding is high.',
      '- clarity=clear only when target users, desired outcome, success criteria, and boundaries are specific enough to write a solid PRD.',
      '- shouldConfirmSummary must be true whenever a concise requirement playback would materially reduce ambiguity.',
      '- shouldDelegateValidation must be true when the requirement is complex, risky, or may describe a solution instead of the real problem.',
      '- nextStep must match the booleans: generate_prd, confirm_summary, or confirm_summary_and_validate.',
      '',
      this.buildRequirementContext(brief, userClarifications),
    ].join('\n');

    try {
      const result = await this.runWithLoading(
        {
          start: this.copy('正在判断需求是否足够清晰，并决定下一步...', 'Assessing requirement clarity and deciding the next step...'),
          success: this.copy('需求门禁判断已完成', 'Requirement gate decision completed'),
          failure: this.copy('需求门禁判断失败，将改用本地规则', 'Requirement gate decision failed; falling back to local rules'),
        },
        () => this.runJsonWithPreferredSlots<RequirementAssessment>(
          this.buildSlotPreference(leadSlot, 'prd'),
          prompt,
          REQUIREMENT_ASSESSMENT_SCHEMA,
        ),
      );
      ChatUI.info('Requirement Routing', this.formatExecutionSummary('需求门禁判断', leadSlot, result.resolution));
      return this.normalizeRequirementAssessment(result.parsed, brief);
    } catch (error) {
      this.reportModelFallback('Requirement Routing', '需求门禁判断：模型执行失败，已切换为本地兜底规则。', error);
      return this.buildRequirementAssessmentFallback(brief, userClarifications);
    }
  }

  private normalizeRequirementAssessment(
    assessment: RequirementAssessment,
    brief: IdeaBrief,
  ): RequirementAssessment {
    const complexity = ['low', 'medium', 'high'].includes(assessment.complexity)
      ? assessment.complexity
      : 'medium';
    const clarity = ['clear', 'needs_confirmation', 'needs_clarification'].includes(assessment.clarity)
      ? assessment.clarity
      : 'needs_confirmation';
    const missingInformation = unique([
      ...safeArray(assessment.missingInformation),
      ...(brief.followUps || []),
    ]).slice(0, 6);
    const recommendedQuestions = unique(safeArray(assessment.recommendedQuestions)).slice(0, 4);
    const keyRisks = unique(safeArray(assessment.keyRisks)).slice(0, 6);
    const shouldDelegateValidation = assessment.shouldDelegateValidation === true || complexity === 'high';
    const shouldConfirmSummary =
      assessment.shouldConfirmSummary === true || shouldDelegateValidation || clarity !== 'clear';

    let nextStep: RequirementAssessment['nextStep'] = assessment.nextStep;
    if (shouldDelegateValidation) {
      nextStep = 'confirm_summary_and_validate';
    } else if (shouldConfirmSummary) {
      nextStep = 'confirm_summary';
    } else {
      nextStep = 'generate_prd';
    }

    return {
      summary: assessment.summary || this.copy('当前需求需要先做一次门禁判断。', 'The current requirement needs a gate decision first.'),
      complexity,
      clarity,
      reasoning: assessment.reasoning || this.copy('未提供额外判断理由。', 'No extra reasoning was provided.'),
      keyRisks,
      missingInformation,
      recommendedQuestions,
      shouldConfirmSummary,
      shouldDelegateValidation,
      nextStep,
    };
  }

  private buildRequirementAssessmentFallback(
    brief: IdeaBrief,
    userClarifications: string[],
  ): RequirementAssessment {
    const haystack = [
      brief.rawIdea,
      brief.targetUsers,
      ...brief.goals,
      ...brief.constraints,
      ...brief.nonGoals,
      ...brief.successCriteria,
      ...brief.assumptions,
      ...brief.followUps,
      ...userClarifications,
    ]
      .join(' ')
      .toLowerCase();

    const missingInformation = unique([
      ...brief.followUps,
      /待在 PRD 阶段进一步确认|暂未明确/.test(brief.targetUsers) ? '首要目标用户还不够明确。' : '',
      brief.successCriteria.some(item => /需要进一步|暂未|待/.test(item)) ? '成功标准还需要再收敛。' : '',
    ]).filter(Boolean);

    let complexityScore = 0;
    if (/(agent|workflow|pipeline|orchestr|multi|多模型|多角色|协作|编排|审批|review|roundtable)/.test(haystack)) {
      complexityScore += 2;
    }
    if (/(github|gitlab|slack|notion|database|db|api|支付|payment|邮件|email|集成|integration)/.test(haystack)) {
      complexityScore += 2;
    }
    if (brief.goals.length >= 3) {
      complexityScore += 1;
    }
    if (brief.constraints.length >= 3) {
      complexityScore += 1;
    }
    if (missingInformation.length >= 2) {
      complexityScore += 1;
    }

    const complexity: RequirementAssessment['complexity'] =
      complexityScore >= 4 ? 'high' : complexityScore >= 2 ? 'medium' : 'low';
    const clarity: RequirementAssessment['clarity'] =
      missingInformation.length >= 3 ? 'needs_clarification' : missingInformation.length > 0 || complexity !== 'low'
        ? 'needs_confirmation'
        : 'clear';
    const shouldDelegateValidation = complexity === 'high';
    const shouldConfirmSummary = shouldDelegateValidation || clarity !== 'clear';

    return {
      summary:
        shouldDelegateValidation
          ? this.copy('需求较复杂，建议先做需求回放并拉其他 Agent 校验后再写 PRD。', 'The requirement is complex and should be played back plus validated by other agents before drafting the PRD.')
          : shouldConfirmSummary
            ? this.copy('需求主体已出现，但还有边界需要先确认，再进入 PRD 更稳妥。', 'The core requirement is present, but some boundaries should be confirmed before PRD drafting.')
            : this.copy('需求范围相对集中，可以直接进入 PRD。', 'The requirement is focused enough to move directly into PRD drafting.'),
      complexity,
      clarity,
      reasoning: this.copy(
        '本地兜底规则综合考虑了需求跨度、外部依赖、待确认项数量，以及是否像“方案先行”而不是“问题先行”。',
        'The local fallback considered scope breadth, external dependencies, open questions, and whether the request sounds solution-first instead of problem-first.',
      ),
      keyRisks: unique([
        complexity !== 'low'
          ? this.copy('如果直接写 PRD，可能会把多阶段流程和能力边界写得过大。', 'Going straight to PRD may over-scope the workflow and capability boundaries.')
          : '',
        missingInformation.length > 0
          ? this.copy('仍有待确认项，可能导致 PRD 建立在错误假设上。', 'Open questions may cause the PRD to rest on the wrong assumptions.')
          : '',
      ]).filter(Boolean),
      missingInformation,
      recommendedQuestions: missingInformation.slice(0, 3),
      shouldConfirmSummary,
      shouldDelegateValidation,
      nextStep: shouldDelegateValidation
        ? 'confirm_summary_and_validate'
        : shouldConfirmSummary
          ? 'confirm_summary'
          : 'generate_prd',
    };
  }

  private async generateRequirementSummary(
    brief: IdeaBrief,
    assessment: RequirementAssessment,
    userClarifications: string[],
    leadSlot: EngineSlot,
  ): Promise<RequirementSummaryCard> {
    const prompt = [
      'You are the lead product manager preparing a concise requirement playback before PRD writing.',
      'Return JSON only.',
      'Do not invent facts. Keep unresolved points in openQuestions.',
      'Keep the summary short, concrete, and usable for user confirmation.',
      '',
      this.buildRequirementContext(brief, userClarifications, assessment),
    ].join('\n');

    try {
      const result = await this.runWithLoading(
        {
          start: this.copy('正在生成需求总结，方便你快速确认范围...', 'Generating a concise requirement playback for confirmation...'),
          success: this.copy('需求总结已生成', 'Requirement summary generated'),
          failure: this.copy('需求总结生成失败，将改用本地兜底摘要', 'Requirement summary failed; falling back to a local summary'),
        },
        () => this.runJsonWithPreferredSlots<RequirementSummaryCard>(
          this.buildSlotPreference(leadSlot, 'prd'),
          prompt,
          REQUIREMENT_SUMMARY_SCHEMA,
        ),
      );
      ChatUI.info('Requirement Summary', this.formatExecutionSummary('需求总结回放', leadSlot, result.resolution));
      return result.parsed;
    } catch (error) {
      this.reportModelFallback('Requirement Summary', '需求总结回放：模型执行失败，已切换为本地兜底摘要。', error);
      return this.buildRequirementSummaryFallback(brief, assessment, userClarifications);
    }
  }

  private buildRequirementSummaryFallback(
    brief: IdeaBrief,
    assessment: RequirementAssessment,
    userClarifications: string[],
  ): RequirementSummaryCard {
    return {
      problem: brief.goals[0] || brief.rawIdea,
      targetUsers: unique([brief.targetUsers]).filter(Boolean),
      desiredOutcome: brief.successCriteria[0] || this.copy('交付一个覆盖核心流程的可验证 MVP。', 'Deliver a verifiable MVP that covers the core workflow.'),
      inScope: unique([...brief.goals, ...brief.constraints.filter(item => item.startsWith('交付形态：'))]).slice(0, 5),
      outOfScope: unique(brief.nonGoals).slice(0, 5),
      assumptions: unique([...brief.assumptions, ...userClarifications.map(item => `补充说明：${item}`)]).slice(0, 5),
      openQuestions: unique([...assessment.missingInformation, ...brief.followUps]).slice(0, 5),
    };
  }

  private async runRequirementValidation(
    brief: IdeaBrief,
    assessment: RequirementAssessment,
    summaryCard: RequirementSummaryCard | undefined,
    userClarifications: string[],
    leadSlot: EngineSlot,
  ): Promise<RequirementValidationReview[]> {
    const validationSlots = ALL_SLOTS.filter(slot => slot !== leadSlot);
    const roles = [
      {
        slot: validationSlots[0],
        focus: this.copy(
          '挑战这个需求是否真的抓住了用户问题，而不是过早固化成方案。',
          'Challenge whether this requirement captures the real user problem instead of locking in a premature solution.',
        ),
      },
      {
        slot: validationSlots[1],
        focus: this.copy(
          '挑战当前信息是否足够支撑高质量 PRD，指出还缺什么。',
          'Challenge whether the current information is specific enough for a strong PRD and call out what is still missing.',
        ),
      },
    ];

    const reviews: RequirementValidationReview[] = [];
    const context = this.buildRequirementContext(brief, userClarifications, assessment, summaryCard);

    for (const role of roles) {
      try {
        const result = await this.runWithLoading(
          {
            start: this.copy(
              `正在进行复杂需求校验（${ENGINE_LABELS[role.slot]}）...`,
              `Running complex requirement validation with ${ENGINE_LABELS[role.slot]}...`,
            ),
            success: this.copy(
              `复杂需求校验已完成（${ENGINE_LABELS[role.slot]}）`,
              `Complex requirement validation completed with ${ENGINE_LABELS[role.slot]}`,
            ),
            failure: this.copy(
              `复杂需求校验失败（${ENGINE_LABELS[role.slot]}），将写入 fallback review`,
              `Complex requirement validation failed for ${ENGINE_LABELS[role.slot]}; writing a fallback review`,
            ),
          },
          () => this.withTransientHealth(() => this.runJsonForSlot<{
            focus: string;
            verdict: RequirementValidationReview['verdict'];
            summary: string;
            concerns: string[];
            suggestedQuestions: string[];
            recommendedActions: string[];
          }>(
            role.slot,
            [
              `You are acting as ${ENGINE_LABELS[role.slot]} inside AegisFlow's requirement validation stage.`,
              `Focus: ${role.focus}`,
              'Return JSON only.',
              'Be skeptical but constructive.',
              'If the requirement is still ambiguous, risky, or likely mismatched to the user need, set verdict=needs_clarification.',
              '',
              context,
            ].join('\n'),
            REQUIREMENT_VALIDATION_SCHEMA,
            {
              timeoutMs: this.config.timeouts.modelExecutionMs,
              allowFallbackProxy: false,
            },
          )),
        );

        ChatUI.info('Requirement Validation Routing', this.formatExecutionSummary('复杂需求校验', role.slot, result.resolution));
        const parsed = result.output.parsed!;
        const review: RequirementValidationReview = {
          reviewer: role.slot,
          reviewerLabel: ENGINE_LABELS[role.slot],
          resolvedBy: result.resolution.resolvedBy,
          proxyUsed: result.resolution.proxyUsed,
          focus: parsed.focus || role.focus,
          verdict: parsed.verdict === 'clear' ? 'clear' : 'needs_clarification',
          summary: parsed.summary || this.copy('未提供摘要。', 'No summary provided.'),
          concerns: safeArray(parsed.concerns),
          suggestedQuestions: safeArray(parsed.suggestedQuestions),
          recommendedActions: safeArray(parsed.recommendedActions),
          rawOutput: result.output.stdout,
        };
        this.store.saveJson(`requirement-check-${role.slot}.json`, review);
        this.store.saveArtifact(`requirement-check-${role.slot}.md`, this.renderRequirementValidationReviewMarkdown(review));
        reviews.push(review);
      } catch (error) {
        this.reportModelFallback(
          'Requirement Validation Routing',
          [
            `复杂需求校验：${ENGINE_LABELS[role.slot]}`,
            `校验视角：${role.focus}`,
            '执行结果：未完成，已写入 fallback review，建议人工补看这一视角。',
          ].join('\n'),
          error,
        );
        const fallbackReview = this.buildFallbackRequirementValidationReview(role.slot, role.focus, error);
        this.store.saveJson(`requirement-check-${role.slot}.json`, fallbackReview);
        this.store.saveArtifact(`requirement-check-${role.slot}.md`, this.renderRequirementValidationReviewMarkdown(fallbackReview));
        reviews.push(fallbackReview);
      }
    }

    return reviews;
  }

  private buildFallbackRequirementValidationReview(
    slot: EngineSlot,
    focus: string,
    error: unknown,
  ): RequirementValidationReview {
    const message = error instanceof Error ? error.message : String(error);
    const conciseMessage = truncate(message.replace(/\s+/g, ' ').trim(), 600);

    return {
      reviewer: slot,
      reviewerLabel: ENGINE_LABELS[slot],
      resolvedBy: slot,
      proxyUsed: false,
      focus,
      verdict: 'needs_clarification',
      summary: this.copy(
        `${ENGINE_LABELS[slot]} 未完成复杂需求校验，建议不要把这轮缺失视角静默忽略。`,
        `${ENGINE_LABELS[slot]} did not complete the complex requirement validation, so this missing lens should not be ignored silently.`,
      ),
      concerns: [
        conciseMessage || this.copy('没有拿到结构化校验结果。', 'No structured validation result was returned.'),
      ],
      suggestedQuestions: [
        this.copy(
          '在进入 PRD 前，是否还需要人工确认这个复杂需求的真实目标和范围边界？',
          'Should the real goal and scope boundary of this complex requirement be confirmed manually before the PRD is written?',
        ),
      ],
      recommendedActions: [
        this.copy(
          '修复对应引擎后重新执行复杂需求校验，或由人工补做这一校验视角。',
          'Re-run complex requirement validation after fixing the engine, or cover this lens manually.',
        ),
      ],
      rawOutput: conciseMessage,
    };
  }

  private summarizeRequirementValidation(
    reviews: RequirementValidationReview[],
    assessment: RequirementAssessment,
  ): RequirementValidationSummary {
    const blockers = unique([
      ...reviews
        .filter(review => review.verdict === 'needs_clarification')
        .flatMap(review => review.concerns),
      ...(assessment.clarity === 'needs_clarification' ? assessment.missingInformation : []),
    ]).filter(Boolean);
    const followUps = unique([
      ...reviews.flatMap(review => review.suggestedQuestions),
      ...assessment.recommendedQuestions,
    ]).filter(Boolean);
    const recommendations = unique(reviews.flatMap(review => review.recommendedActions)).filter(Boolean);
    const proceedToPrd = blockers.length === 0;

    return {
      summary: proceedToPrd
        ? this.copy('复杂需求校验认为当前信息已经足够，可以继续进入 PRD。', 'Complex requirement validation found the current information sufficient to proceed into the PRD.')
        : this.copy('复杂需求校验认为仍有关键不确定项，建议先补充再写 PRD。', 'Complex requirement validation found remaining critical uncertainties, so more clarification is recommended before the PRD is drafted.'),
      proceedToPrd,
      blockers,
      followUps,
      recommendations,
    };
  }

  private buildRequirementContext(
    brief: IdeaBrief,
    userClarifications: string[],
    assessment?: RequirementAssessment,
    summaryCard?: RequirementSummaryCard,
  ): string {
    return [
      `Idea brief JSON:\n${JSON.stringify(brief, null, 2)}`,
      assessment ? `Lead assessment JSON:\n${JSON.stringify(assessment, null, 2)}` : '',
      summaryCard ? `Requirement summary JSON:\n${JSON.stringify(summaryCard, null, 2)}` : '',
      userClarifications.length > 0
        ? `User clarification notes:\n${userClarifications.map(item => `- ${item}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private saveRequirementClarifications(clarifications: string[]) {
    this.store.saveJson('requirement-clarifications.json', clarifications);
    this.store.saveArtifact('requirement-clarifications.md', this.renderRequirementClarificationsMarkdown(clarifications));
  }

  private async stage1PRD() {
    this.store.markStage('stage1-prd', 'running');

    if (this.store.exists('prd-final.md')) {
      this.store.markStage('stage1-prd', 'completed', 'Recovered approved PRD');
      return;
    }

    const brief = this.mustReadJson<IdeaBrief>('idea-brief.json');
    const requirementPackMarkdown = this.store.readArtifact('requirement-pack.md');
    const leadSlot = this.selectDesignLead(brief);

    ChatUI.stage('Stage 1', [
      `PRD 主写：${ENGINE_LABELS[leadSlot]}`,
      '人工确认：用户',
      '说明：PRD 只有在用户确认后才会进入下一阶段。',
    ]);

    let prdDraft = this.store.readArtifact('prd-draft.md');
    if (prdDraft) {
      const normalizedDraft = normalizeMarkdownDocument(prdDraft);
      if (normalizedDraft !== prdDraft) {
        prdDraft = normalizedDraft;
        this.store.saveArtifact('prd-draft.md', prdDraft);
      }
    }
    let revisionRequest: string | null = null;

    while (!this.store.exists('prd-final.md')) {
      if (!prdDraft || revisionRequest) {
        const prompt = [
          'You are a senior product manager.',
          'Write a PRD in markdown for the following approved requirement package.',
          'The PRD must contain: Background, Goals, Scope, Non-Goals, User Scenarios, Functional Requirements, Non-Functional Requirements, Risks, Milestones, Acceptance Criteria.',
          'Keep it concrete and implementation-oriented.',
          'If the requirement pack still contains uncertainty, make it explicit in assumptions, scope notes, or risks instead of inventing facts.',
          'Return raw markdown only. Do not wrap the answer in triple backticks.',
          'Do not add any explanation before the document.',
          '',
          requirementPackMarkdown
            ? `Requirement package:\n${requirementPackMarkdown}`
            : `Idea brief JSON:\n${JSON.stringify(brief, null, 2)}`,
          revisionRequest ? `\nRevision request from user:\n${revisionRequest}` : '',
        ].join('\n');

        const result = await this.runWithLoading(
          {
            start: '正在生成 PRD 草稿...',
            success: 'PRD 草稿已生成',
            failure: 'PRD 草稿生成失败',
          },
          () => this.runTextWithPreferredSlots(this.buildSlotPreference(leadSlot, 'prd'), prompt),
          {
            heartbeatMs: 30_000,
            onHeartbeat: elapsedMs => this.copy(
              `${ENGINE_LABELS[leadSlot]} 仍在主写 PRD 草稿，已等待 ${this.formatDurationMs(elapsedMs)}。`,
              `${ENGINE_LABELS[leadSlot]} is still drafting the PRD (${this.formatDurationMs(elapsedMs)} elapsed).`,
            ),
          },
        );
        ChatUI.info('PRD Routing', this.formatExecutionSummary('PRD 主写', leadSlot, result.resolution));
        prdDraft = normalizeMarkdownDocument(result.output.stdout);
        this.store.saveArtifact('prd-draft.md', prdDraft);
      }

      const prdDraftPath = this.store.getArtifactPath('prd-draft.md');
      ChatUI.showArtifact('PRD Draft Preview', truncate(prdDraft, 1200), prdDraftPath);
      await ChatUI.inspectArtifact('PRD Draft', prdDraftPath);
      const approved = await ChatUI.showApproval('PRD Draft');
      this.store.appendArtifact(
        'approval-log.md',
        `[${nowIso()}] PRD ${approved ? 'approved' : 'sent back for revision'}\n`,
      );

      if (approved) {
        this.store.saveArtifact('prd-final.md', prdDraft);
        break;
      }

      revisionRequest = await ChatUI.askRevisionRequest('PRD');
      this.store.appendArtifact('approval-log.md', `[${nowIso()}] PRD revision note: ${revisionRequest}\n`);
      prdDraft = null;
    }

    this.store.markStage('stage1-prd', 'completed', 'PRD approved');
  }

  private async runReviewPrdCommand(command: ReviewPrdSlashCommand): Promise<string> {
    this.store.markStage('command-reviewprd', 'running');

    const capturedAt = nowIso();
    const prdContent = normalizeMarkdownDocument(fs.readFileSync(command.targetFilePath, 'utf-8'));
    const reviewSlots = ALL_SLOTS;

    this.store.saveJson('reviewprd-request.json', {
      command: command.rawInput,
      targetFilePath: command.targetFilePath,
      capturedAt,
    });
    this.store.saveArtifact(
      'reviewprd-source.md',
      this.renderReviewPrdSourceMarkdown(command.targetFilePath, prdContent, capturedAt),
    );

    ChatUI.stage('PRD Review', [
      `命令：${command.rawInput}`,
      `目标文件：${command.targetFilePath}`,
      `独立 Reviewer：${reviewSlots.map(slot => `${ENGINE_LABELS[slot]} (${this.describePrdReviewLens(slot)})`).join(' / ')}`,
      `PRD 报告主写：${ENGINE_LABELS.codex}`,
      '说明：直接评审本地现有 PRD，不会启动完整的 0-7 阶段流水线。',
      `输出：用户可直接查看的文件会写入当前目录：${path.join(this.store.getWorkspaceDir(), 'prd-review.md')} / ${path.join(this.store.getWorkspaceDir(), 'prd-revised.md')}`,
    ]);

    const reviews = await this.runParallelPrdReviews(command, prdContent, reviewSlots);

    const consensus = this.summarizePrdReviews(reviews);
    const revisedPrd = await this.generateRevisedPrdFromReviews(command, prdContent, consensus, reviews);
    this.store.saveArtifact('reviewprd-revised.md', revisedPrd);

    const revisedPrdPath = this.store.getArtifactPath('reviewprd-revised.md');
    const reportMarkdown = await this.generatePrdReviewReport(command, prdContent, consensus, reviews, revisedPrdPath);
    this.store.saveJson('reviewprd-consensus.json', consensus);
    this.store.saveArtifact('reviewprd-report.md', reportMarkdown);
    this.store.markStage('command-reviewprd', 'completed', `Reviewed PRD: ${path.basename(command.targetFilePath)}`);

    const reportPath = this.store.getArtifactPath('reviewprd-report.md');
    ChatUI.showArtifact('PRD Review Preview', truncate(reportMarkdown, 1200), reportPath);
    await ChatUI.inspectArtifact('PRD Review Report', reportPath);
    ChatUI.showArtifact('Revised PRD Preview', truncate(revisedPrd, 1200), revisedPrdPath);
    await ChatUI.inspectArtifact('Revised PRD', revisedPrdPath);

    return this.copy(
      `PRD 评审已完成。当前目录已生成：\n- ${reportPath}\n- ${revisedPrdPath}`,
      `PRD review completed. The current workspace now contains:\n- ${reportPath}\n- ${revisedPrdPath}`,
    );
  }

  private async runReviewDesignCommand(command: ReviewDesignSlashCommand): Promise<string> {
    this.store.markStage('command-reviewd', 'running');

    const capturedAt = nowIso();
    const designContent = normalizeMarkdownDocument(fs.readFileSync(command.targetFilePath, 'utf-8'));
    const reviewSlots = ALL_SLOTS;

    this.store.saveJson('reviewd-request.json', {
      command: command.rawInput,
      targetFilePath: command.targetFilePath,
      capturedAt,
    });
    this.store.saveArtifact(
      'reviewd-source.md',
      this.renderReviewDesignSourceMarkdown(command.targetFilePath, designContent, capturedAt),
    );

    ChatUI.stage('Design Review', [
      `命令：${command.rawInput}`,
      `目标文件：${command.targetFilePath}`,
      `独立 Reviewer：${reviewSlots.map(slot => `${ENGINE_LABELS[slot]} (${this.describeDesignReviewLens(slot)})`).join(' / ')}`,
      `Design 报告主写：${ENGINE_LABELS.codex}`,
      '说明：直接评审本地现有技术设计，不会启动完整的 0-7 阶段流水线。',
      `输出：用户可直接查看的文件会写入当前目录：${path.join(this.store.getWorkspaceDir(), 'design-review.md')} / ${path.join(this.store.getWorkspaceDir(), 'design-revised.md')}`,
    ]);

    const reviews = await this.runParallelDesignReviews(command, designContent, reviewSlots);

    const consensus = ConsensusEngine.summarizeReviews(reviews, this.config.language);
    const revisedDesign = await this.generateRevisedDesignFromReviews(command, designContent, consensus, reviews);
    this.store.saveArtifact('reviewd-revised.md', revisedDesign);

    const revisedDesignPath = this.store.getArtifactPath('reviewd-revised.md');
    const reportMarkdown = await this.generateDesignReviewReport(command, designContent, consensus, reviews, revisedDesignPath);
    this.store.saveJson('reviewd-consensus.json', consensus);
    this.store.saveArtifact('reviewd-report.md', reportMarkdown);
    this.store.markStage('command-reviewd', 'completed', `Reviewed design: ${path.basename(command.targetFilePath)}`);

    const reportPath = this.store.getArtifactPath('reviewd-report.md');
    ChatUI.showArtifact('Design Review Preview', truncate(reportMarkdown, 1200), reportPath);
    await ChatUI.inspectArtifact('Design Review Report', reportPath);
    ChatUI.showArtifact('Revised Design Preview', truncate(revisedDesign, 1200), revisedDesignPath);
    await ChatUI.inspectArtifact('Revised Design', revisedDesignPath);

    return this.copy(
      `技术设计评审已完成。当前目录已生成：\n- ${reportPath}\n- ${revisedDesignPath}`,
      `Technical design review completed. The current workspace now contains:\n- ${reportPath}\n- ${revisedDesignPath}`,
    );
  }

  private async runParallelPrdReviews(
    command: ReviewPrdSlashCommand,
    prdContent: string,
    reviewSlots: EngineSlot[],
  ): Promise<StructuredReview[]> {
    const reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>> = {};

    for (const slot of reviewSlots) {
      reviewProgress[slot] = {
        status: 'queued',
        detail: this.copy('等待并行评审启动。', 'Waiting for the parallel review wave to start.'),
      };
    }

    const announce = (currentAction: string) => {
      this.announcePrdReviewProgress(command.targetFilePath, reviewSlots, reviewProgress, currentAction);
    };

    announce(
      this.copy(
        `准备并行启动 ${reviewSlots.length} 个 Reviewer。`,
        `Preparing to launch ${reviewSlots.length} reviewers in parallel.`,
      ),
    );

    this.unhealthySlots.clear();
    try {
      return await this.runWithLoading(
        {
          start: this.copy('正在并行运行 PRD 独立评审...', 'Running independent PRD reviews in parallel...'),
          success: this.copy('PRD 独立评审已全部完成', 'All independent PRD reviews completed'),
          failure: this.copy('并行 PRD 评审阶段异常退出', 'The parallel PRD review phase exited unexpectedly'),
        },
        () =>
          Promise.all(
            reviewSlots.map(slot =>
              this.runPrdReviewForSlot(slot, command, prdContent, reviewProgress, announce),
            ),
          ),
        {
          heartbeatMs: 30_000,
          onHeartbeat: elapsedMs => {
            const activeSlots = reviewSlots.filter(slot => reviewProgress[slot]?.status === 'running');
            const pendingSlots = reviewSlots.filter(slot => {
              const status = reviewProgress[slot]?.status;
              return status === 'queued' || status === 'running';
            });
            const activeLabel = activeSlots.length > 0 ? activeSlots.map(slot => ENGINE_LABELS[slot]).join(' / ') : this.copy('无', 'none');
            return this.copy(
              `并行 PRD 评审仍在进行中，已等待 ${this.formatDurationMs(elapsedMs)}。活跃 Reviewer：${activeLabel}。剩余 ${pendingSlots.length} 个。`,
              `Parallel PRD reviews are still running (${this.formatDurationMs(elapsedMs)} elapsed). Active reviewers: ${activeLabel}. ${pendingSlots.length} remaining.`,
            );
          },
        },
      );
    } finally {
      this.unhealthySlots.clear();
    }
  }

  private async runPrdReviewForSlot(
    slot: EngineSlot,
    command: ReviewPrdSlashCommand,
    prdContent: string,
    reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>>,
    announce: (currentAction: string) => void,
  ): Promise<StructuredReview> {
    const prompt = [
      `You are acting as ${ENGINE_LABELS[slot]} inside AegisFlow.`,
      `Review the PRD independently from this lens: ${this.describePrdReviewLens(slot)}.`,
      'Treat this as a PRD review, not a technical design review.',
      'Return JSON only.',
      'Review criteria:',
      '- Verify whether the problem statement, goals, scope, non-goals, user scenarios, requirements, risks, milestones, and acceptance criteria are concrete and internally consistent.',
      '- Prefer actionable findings over generic compliments.',
      '- Explicitly call out ambiguity, contradictory statements, unrealistic scope, missing edge cases, or weak acceptance criteria.',
      '- If the PRD is strong enough to proceed, say that clearly in the summary and suggested decision.',
      '',
      `PRD file path: ${command.targetFilePath}`,
      '',
      `PRD content:\n${prdContent}`,
    ].join('\n');

    reviewProgress[slot] = {
      status: 'running',
      detail: this.copy(
        `正在独立评审 ${path.basename(command.targetFilePath)}。`,
        `Independently reviewing ${path.basename(command.targetFilePath)}.`,
      ),
    };
    announce(
      this.copy(
        `${ENGINE_LABELS[slot]} 已启动独立评审。`,
        `${ENGINE_LABELS[slot]} has started its independent review.`,
      ),
    );

    try {
      const result = await this.runJsonForSlot<{
        lens: string;
        verdict: ReviewVerdict;
        summary: string;
        findings: StructuredReview['findings'];
        openQuestions: string[];
        suggestedDecision: string;
      }>(slot, prompt, REVIEW_SCHEMA, {
        timeoutMs: this.config.timeouts.modelExecutionMs,
        allowFallbackProxy: false,
      });

      ChatUI.info('PRD Review Routing', this.formatExecutionSummary('PRD Reviewer', slot, result.resolution));
      const parsed = result.output.parsed!;
      const review: StructuredReview = {
        reviewer: slot,
        reviewerLabel: ENGINE_LABELS[slot],
        resolvedBy: result.resolution.resolvedBy,
        proxyUsed: result.resolution.proxyUsed,
        lens: parsed.lens || this.describePrdReviewLens(slot),
        verdict: parsed.verdict || 'Needs Discussion',
        summary: parsed.summary || this.copy('未提供摘要。', 'No summary provided.'),
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        openQuestions: safeArray(parsed.openQuestions),
        suggestedDecision: parsed.suggestedDecision || this.copy('建议先处理关键问题，再决定是否进入下一步。', 'Address the key findings before deciding whether to proceed.'),
        rawOutput: result.output.stdout,
      };

      this.store.saveJson(`reviewprd-${slot}.json`, review);
      this.store.saveArtifact(`reviewprd-${slot}.md`, ConsensusEngine.renderReviewMarkdown(review, this.config.language));
      reviewProgress[slot] = {
        status: 'completed',
        detail: this.copy('独立评审已完成。', 'Independent review completed.'),
        durationMs: result.output.durationMs,
        resolution: result.resolution,
      };
      announce(
        this.copy(
          `${ENGINE_LABELS[slot]} 已完成独立评审。`,
          `${ENGINE_LABELS[slot]} completed its independent review.`,
        ),
      );
      return review;
    } catch (error) {
      this.reportModelFallback(
        'PRD Review Routing',
        [
          `Review 角色：${ENGINE_LABELS[slot]}`,
          `评审对象：${path.basename(command.targetFilePath)}`,
          '执行结果：未完成，已写入 fallback review，建议人工补看这一视角。',
        ].join('\n'),
        error,
        [
          `Review 角色：${ENGINE_LABELS[slot]}`,
          `评审对象：${command.targetFilePath}`,
          `评审视角：${this.describePrdReviewLens(slot)}`,
          '执行限制：此命令要求对应 reviewer 直连执行，不会自动切代理。',
          `超时阈值：${this.formatDurationMs(this.config.timeouts.modelExecutionMs)}`,
        ].join('\n'),
      );
      const fallbackReview = this.buildPrdReviewFallbackReview(slot, error, command.targetFilePath);
      this.store.saveJson(`reviewprd-${slot}.json`, fallbackReview);
      this.store.saveArtifact(`reviewprd-${slot}.md`, ConsensusEngine.renderReviewMarkdown(fallbackReview, this.config.language));
      reviewProgress[slot] = {
        status: 'fallback',
        detail: this.copy('已写入 fallback review。', 'Fallback review saved.'),
      };
      announce(
        this.copy(
          `${ENGINE_LABELS[slot]} 未完成独立评审，已写入 fallback review。`,
          `${ENGINE_LABELS[slot]} did not complete its independent review; a fallback review was saved.`,
        ),
      );
      return fallbackReview;
    }
  }

  private async runParallelDesignReviews(
    command: ReviewDesignSlashCommand,
    designContent: string,
    reviewSlots: EngineSlot[],
  ): Promise<StructuredReview[]> {
    const reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>> = {};

    for (const slot of reviewSlots) {
      reviewProgress[slot] = {
        status: 'queued',
        detail: this.copy('等待并行评审启动。', 'Waiting for the parallel review wave to start.'),
      };
    }

    const announce = (currentAction: string) => {
      this.announceDesignReviewProgress(command.targetFilePath, reviewSlots, reviewProgress, currentAction);
    };

    announce(
      this.copy(
        `准备并行启动 ${reviewSlots.length} 个 Reviewer。`,
        `Preparing to launch ${reviewSlots.length} reviewers in parallel.`,
      ),
    );

    this.unhealthySlots.clear();
    try {
      return await this.runWithLoading(
        {
          start: this.copy('正在并行运行技术设计独立评审...', 'Running independent technical design reviews in parallel...'),
          success: this.copy('技术设计独立评审已全部完成', 'All independent technical design reviews completed'),
          failure: this.copy('并行技术设计评审阶段异常退出', 'The parallel technical design review phase exited unexpectedly'),
        },
        () =>
          Promise.all(
            reviewSlots.map(slot =>
              this.runDesignReviewForSlot(slot, command, designContent, reviewProgress, announce),
            ),
          ),
        {
          heartbeatMs: 30_000,
          onHeartbeat: elapsedMs => {
            const activeSlots = reviewSlots.filter(slot => reviewProgress[slot]?.status === 'running');
            const pendingSlots = reviewSlots.filter(slot => {
              const status = reviewProgress[slot]?.status;
              return status === 'queued' || status === 'running';
            });
            const activeLabel = activeSlots.length > 0 ? activeSlots.map(slot => ENGINE_LABELS[slot]).join(' / ') : this.copy('无', 'none');
            return this.copy(
              `并行技术设计评审仍在进行中，已等待 ${this.formatDurationMs(elapsedMs)}。活跃 Reviewer：${activeLabel}。剩余 ${pendingSlots.length} 个。`,
              `Parallel technical design reviews are still running (${this.formatDurationMs(elapsedMs)} elapsed). Active reviewers: ${activeLabel}. ${pendingSlots.length} remaining.`,
            );
          },
        },
      );
    } finally {
      this.unhealthySlots.clear();
    }
  }

  private async runDesignReviewForSlot(
    slot: EngineSlot,
    command: ReviewDesignSlashCommand,
    designContent: string,
    reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>>,
    announce: (currentAction: string) => void,
  ): Promise<StructuredReview> {
    const prompt = [
      `You are acting as ${ENGINE_LABELS[slot]} inside AegisFlow.`,
      `Review the technical design independently from this lens: ${this.describeDesignReviewLens(slot)}.`,
      'Treat this as a technical design review, not a PRD review.',
      'Return JSON only.',
      'Review criteria:',
      '- Verify whether the architecture, module boundaries, interfaces, data flow, error handling, observability, rollout, risks, and test strategy are concrete and internally consistent.',
      '- Prefer actionable findings over generic praise.',
      '- Explicitly call out vague interfaces, unrealistic implementation assumptions, missing operational details, weak testability, or unclear migration/rollout plans.',
      '- If the design is strong enough to proceed, say that clearly in the summary and suggested decision.',
      '',
      `Technical design file path: ${command.targetFilePath}`,
      '',
      `Technical design content:\n${designContent}`,
    ].join('\n');

    reviewProgress[slot] = {
      status: 'running',
      detail: this.copy(
        `正在独立评审 ${path.basename(command.targetFilePath)}。`,
        `Independently reviewing ${path.basename(command.targetFilePath)}.`,
      ),
    };
    announce(
      this.copy(
        `${ENGINE_LABELS[slot]} 已启动独立评审。`,
        `${ENGINE_LABELS[slot]} has started its independent review.`,
      ),
    );

    try {
      const result = await this.runJsonForSlot<{
        lens: string;
        verdict: ReviewVerdict;
        summary: string;
        findings: StructuredReview['findings'];
        openQuestions: string[];
        suggestedDecision: string;
      }>(slot, prompt, REVIEW_SCHEMA, {
        timeoutMs: this.config.timeouts.modelExecutionMs,
        allowFallbackProxy: false,
      });

      ChatUI.info('Design Review Routing', this.formatExecutionSummary('Design Reviewer', slot, result.resolution));
      const parsed = result.output.parsed!;
      const review: StructuredReview = {
        reviewer: slot,
        reviewerLabel: ENGINE_LABELS[slot],
        resolvedBy: result.resolution.resolvedBy,
        proxyUsed: result.resolution.proxyUsed,
        lens: parsed.lens || this.describeDesignReviewLens(slot),
        verdict: parsed.verdict || 'Needs Discussion',
        summary: parsed.summary || this.copy('未提供摘要。', 'No summary provided.'),
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        openQuestions: safeArray(parsed.openQuestions),
        suggestedDecision: parsed.suggestedDecision || this.copy('建议先处理关键问题，再决定是否进入下一步。', 'Address the key findings before deciding whether to proceed.'),
        rawOutput: result.output.stdout,
      };

      this.store.saveJson(`reviewd-${slot}.json`, review);
      this.store.saveArtifact(`reviewd-${slot}.md`, ConsensusEngine.renderReviewMarkdown(review, this.config.language));
      reviewProgress[slot] = {
        status: 'completed',
        detail: this.copy('独立评审已完成。', 'Independent review completed.'),
        durationMs: result.output.durationMs,
        resolution: result.resolution,
      };
      announce(
        this.copy(
          `${ENGINE_LABELS[slot]} 已完成独立评审。`,
          `${ENGINE_LABELS[slot]} completed its independent review.`,
        ),
      );
      return review;
    } catch (error) {
      this.reportModelFallback(
        'Design Review Routing',
        [
          `Review 角色：${ENGINE_LABELS[slot]}`,
          `评审对象：${path.basename(command.targetFilePath)}`,
          '执行结果：未完成，已写入 fallback review，建议人工补看这一视角。',
        ].join('\n'),
        error,
        [
          `Review 角色：${ENGINE_LABELS[slot]}`,
          `评审对象：${command.targetFilePath}`,
          `评审视角：${this.describeDesignReviewLens(slot)}`,
          '执行限制：此命令要求对应 reviewer 直连执行，不会自动切代理。',
          `超时阈值：${this.formatDurationMs(this.config.timeouts.modelExecutionMs)}`,
        ].join('\n'),
      );
      const fallbackReview = this.buildDesignReviewFallbackReview(slot, error, command.targetFilePath);
      this.store.saveJson(`reviewd-${slot}.json`, fallbackReview);
      this.store.saveArtifact(`reviewd-${slot}.md`, ConsensusEngine.renderReviewMarkdown(fallbackReview, this.config.language));
      reviewProgress[slot] = {
        status: 'fallback',
        detail: this.copy('已写入 fallback review。', 'Fallback review saved.'),
      };
      announce(
        this.copy(
          `${ENGINE_LABELS[slot]} 未完成独立评审，已写入 fallback review。`,
          `${ENGINE_LABELS[slot]} did not complete its independent review; a fallback review was saved.`,
        ),
      );
      return fallbackReview;
    }
  }

  private async stage2TechDesign() {
    this.store.markStage('stage2-tech-design', 'running');

    if (this.store.exists('tech-design-draft.md')) {
      this.store.markStage('stage2-tech-design', 'completed', 'Recovered existing design draft');
      return;
    }

    const brief = this.mustReadJson<IdeaBrief>('idea-brief.json');
    const prd = this.mustReadArtifact('prd-final.md');
    const leadSlot = this.selectDesignLead(brief);

    ChatUI.stage('Stage 2', [
      `技术设计主写：${ENGINE_LABELS[leadSlot]}`,
      `主写关注点：${ENGINE_STAGE_HINTS[leadSlot]}`,
      '说明：若主写模型暂不可用，会自动切换到可用模型代理执行，但主写角色保持不变。',
      '进度提示：长文阶段仅显示状态与心跳，正文会在生成完成后统一展示。',
    ]);
    this.announceTechDesignProgress(leadSlot, 'running');

    const prompt = [
      'You are the technical design lead for AegisFlow.',
      'Write a detailed technical design in markdown.',
      'The design must include: architecture overview, modules, data flow, adapter strategy, roundtable mechanism, task routing, execution strategy, integration review, risks, alternatives.',
      'Reference the approved PRD and keep the design grounded in a local CLI orchestrator architecture.',
      'Return raw markdown only. Do not wrap the answer in triple backticks.',
      'Do not add any explanation before the document.',
      '',
      `Approved PRD:\n${prd}`,
    ].join('\n');

    const result = await this.runWithLoading(
      {
        start: '正在生成技术设计草稿...',
        success: '技术设计草稿已生成',
        failure: '技术设计草稿生成失败',
      },
      () => this.runTextWithPreferredSlots(this.buildSlotPreference(leadSlot, 'techDesign'), prompt),
      {
        heartbeatMs: 30_000,
        onHeartbeat: elapsedMs => this.copy(
          `${ENGINE_LABELS[leadSlot]} 仍在主写技术设计草稿，已等待 ${this.formatDurationMs(elapsedMs)}。`,
          `${ENGINE_LABELS[leadSlot]} is still drafting the technical design (${this.formatDurationMs(elapsedMs)} elapsed).`,
        ),
      },
    );

    ChatUI.info('Tech Design Routing', this.formatExecutionSummary('技术设计主写', leadSlot, result.resolution));

    this.store.saveArtifact('tech-design-draft.md', normalizeMarkdownDocument(result.output.stdout));
    this.store.saveJson('tech-design-lead.json', {
      leadSlot,
      resolvedBy: result.resolution.resolvedBy,
      proxyUsed: result.resolution.proxyUsed,
      generatedAt: nowIso(),
    });
    this.announceTechDesignProgress(leadSlot, 'completed', result.resolution, result.output.durationMs);
    this.store.markStage(
      'stage2-tech-design',
      'completed',
      result.resolution.proxyUsed
        ? `Drafted as ${ENGINE_LABELS[leadSlot]} via ${result.resolution.resolvedLabel}`
        : `Drafted by ${ENGINE_LABELS[leadSlot]}`,
    );
  }

  private async stage3Reviews(): Promise<StructuredReview[]> {
    this.store.markStage('stage3-reviews', 'running');
    const leadMeta = this.mustReadJson<{ leadSlot: EngineSlot; resolvedBy: EngineSlot; proxyUsed?: boolean }>(
      'tech-design-lead.json',
    );
    const reviewSlots = ALL_SLOTS.filter(candidate => candidate !== leadMeta.resolvedBy);
    const leadResolution: SlotResolution = {
      slot: leadMeta.leadSlot,
      slotLabel: ENGINE_LABELS[leadMeta.leadSlot],
      resolvedBy: leadMeta.resolvedBy,
      resolvedLabel: ENGINE_LABELS[leadMeta.resolvedBy],
      proxyUsed: leadMeta.proxyUsed === true,
    };

    ChatUI.stage('Stage 3', [
      ...this.formatExecutionSummary('技术设计主写', leadMeta.leadSlot, leadResolution).split('\n'),
      ...reviewSlots.map(
        (slot, index) => `Review ${index + 1}：${ENGINE_LABELS[slot]} (${ENGINE_STAGE_HINTS[slot]})`,
      ),
      '执行方式：当前版本按 Reviewer 串行执行，会依次显示等待中 / 进行中 / 已完成。',
      ...(ChatUI.canUseInteractiveTaskSession()
        ? [this.copy('快捷操作：等待当前 Reviewer 时可按 s 跳过当前 review。', 'Shortcut: press s while waiting to skip the current review.')]
        : []),
    ]);

    const existing = this.loadExistingReviews();
    if (existing.length > 0 && this.store.exists('consensus-report.md')) {
      this.store.markStage('stage3-reviews', 'completed', 'Recovered prior reviews');
      return existing;
    }

    const prd = this.mustReadArtifact('prd-final.md');
    const design = this.mustReadArtifact('tech-design-draft.md');

    const reviews: StructuredReview[] = [];
    const usedTargets: EngineSlot[] = [leadMeta.resolvedBy];
    const reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>> = {};

    for (const slot of reviewSlots) {
      reviewProgress[slot] = {
        status: 'queued',
        detail: this.copy('等待前序 Reviewer 完成后启动。', 'Waiting for earlier reviewers to finish.'),
      };
    }

    this.announceReviewProgress(
      leadMeta.leadSlot,
      leadResolution,
      reviewSlots,
      reviewProgress,
      this.copy(
        `准备启动独立 Review。首先会由 ${ENGINE_LABELS[reviewSlots[0]]} 开始。`,
        `Preparing independent reviews. ${ENGINE_LABELS[reviewSlots[0]]} will start first.`,
      ),
    );

    for (const slot of reviewSlots) {
      const prompt = [
        `You are acting as ${ENGINE_LABELS[slot]} inside AegisFlow.`,
        `Review the technical design independently from a ${ENGINE_LENSES[slot]} perspective.`,
        'Return JSON only.',
        '',
        `Approved PRD:\n${prd}`,
        '',
        `Technical design draft:\n${design}`,
      ].join('\n');
      reviewProgress[slot] = {
        status: 'running',
        detail: this.copy(
          `正在 review ${ENGINE_LABELS[leadMeta.leadSlot]} 主写的技术设计草稿。`,
          `Reviewing the technical design drafted by ${ENGINE_LABELS[leadMeta.leadSlot]}.`,
        ),
      };
      this.announceReviewProgress(
        leadMeta.leadSlot,
        leadResolution,
        reviewSlots,
        reviewProgress,
        this.copy(
          `${ENGINE_LABELS[slot]} 正在独立 review ${ENGINE_LABELS[leadMeta.leadSlot]} 写的技术设计草稿。`,
          `${ENGINE_LABELS[slot]} is independently reviewing the design drafted by ${ENGINE_LABELS[leadMeta.leadSlot]}.`,
        ),
      );

      try {
        const result = await this.runWithLoading(
          {
            start: this.copy(
              `正在等待 ${ENGINE_LABELS[slot]} 完成独立 Review...`,
              `Waiting for ${ENGINE_LABELS[slot]} to finish its independent review...`,
            ),
            success: this.copy(
              `${ENGINE_LABELS[slot]} 的独立 Review 已完成`,
              `${ENGINE_LABELS[slot]}'s independent review is complete`,
            ),
            failure: this.copy(
              `${ENGINE_LABELS[slot]} 的独立 Review 失败，将改用兜底评审`,
              `${ENGINE_LABELS[slot]}'s independent review failed; falling back to a synthetic review`,
            ),
            skipped: this.copy(
              `${ENGINE_LABELS[slot]} 的独立 Review 已手动跳过，将继续后续流程`,
              `${ENGINE_LABELS[slot]}'s independent review was skipped manually. Continuing the workflow.`,
            ),
          },
          signal => this.withTransientHealth(() =>
            this.runJsonForSlot<{
              lens: string;
              verdict: ReviewVerdict;
              summary: string;
              findings: StructuredReview['findings'];
              openQuestions: string[];
              suggestedDecision: string;
            }>(slot, prompt, REVIEW_SCHEMA, {
              timeoutMs: this.config.timeouts.modelExecutionMs,
              avoidTargets: usedTargets,
              allowFallbackProxy: false,
              signal,
            }),
          ),
          {
            heartbeatMs: 30_000,
            onHeartbeat: elapsedMs => this.copy(
              `${ENGINE_LABELS[slot]} 仍在独立 Review ${ENGINE_LABELS[leadMeta.leadSlot]} 主写的技术设计草稿，已等待 ${this.formatDurationMs(elapsedMs)}。`,
              `${ENGINE_LABELS[slot]} is still reviewing the design drafted by ${ENGINE_LABELS[leadMeta.leadSlot]} (${this.formatDurationMs(elapsedMs)} elapsed).`,
            ),
            interrupt: {
              key: 's',
              hint: this.copy(
                `按 s 跳过当前 review（${ENGINE_LABELS[slot]}）。`,
                `Press s to skip the current review (${ENGINE_LABELS[slot]}).`,
              ),
              createError: () => new UserSkippedReviewError(slot),
              onTrigger: () => {
                reviewProgress[slot] = {
                  status: 'running',
                  detail: this.copy('已收到跳过请求，正在停止当前 Reviewer。', 'Skip requested. Stopping the current reviewer.'),
                };
                this.announceReviewProgress(
                  leadMeta.leadSlot,
                  leadResolution,
                  reviewSlots,
                  reviewProgress,
                  this.copy(
                    `已收到手动跳过请求，正在停止 ${ENGINE_LABELS[slot]} 当前 review。`,
                    `Manual skip requested. Stopping ${ENGINE_LABELS[slot]}'s current review.`,
                  ),
                );
              },
            },
          },
        );
        usedTargets.push(result.resolution.resolvedBy);
        ChatUI.info('Review Routing', this.formatExecutionSummary('Review 角色', slot, result.resolution));
        reviewProgress[slot] = {
          status: 'completed',
          detail: this.copy('独立 Review 已完成。', 'Independent review completed.'),
          durationMs: result.output.durationMs,
          resolution: result.resolution,
        };
        this.announceReviewProgress(
          leadMeta.leadSlot,
          leadResolution,
          reviewSlots,
          reviewProgress,
          this.describeNextReviewAction(leadMeta.leadSlot, reviewSlots, reviewProgress),
        );

        const parsed = result.output.parsed!;
        const review: StructuredReview = {
          reviewer: slot,
          reviewerLabel: ENGINE_LABELS[slot],
          resolvedBy: result.resolution.resolvedBy,
          proxyUsed: result.resolution.proxyUsed,
          lens: parsed.lens || ENGINE_LENSES[slot],
          verdict: parsed.verdict || 'Needs Discussion',
          summary: parsed.summary || this.copy('未提供摘要。', 'No summary provided.'),
          findings: Array.isArray(parsed.findings) ? parsed.findings : [],
          openQuestions: safeArray(parsed.openQuestions),
          suggestedDecision: parsed.suggestedDecision || 'Needs deeper roundtable discussion.',
          rawOutput: result.output.stdout,
        };

        this.store.saveJson(`review-${slot}.json`, review);
        this.store.saveArtifact(`review-${slot}.md`, ConsensusEngine.renderReviewMarkdown(review, this.config.language));
        reviews.push(review);
      } catch (error) {
        if (this.isUserSkippedReviewError(error)) {
          const skippedReview = this.buildSkippedReview(slot);
          this.store.appendArtifact(
            'approval-log.md',
            `[${nowIso()}] Review skipped by user: ${ENGINE_LABELS[slot]} (${ENGINE_STAGE_HINTS[slot]})\n`,
          );
          this.store.saveJson(`review-${slot}.json`, skippedReview);
          this.store.saveArtifact(`review-${slot}.md`, ConsensusEngine.renderReviewMarkdown(skippedReview, this.config.language));
          reviews.push(skippedReview);
          reviewProgress[slot] = {
            status: 'skipped',
            detail: this.copy('用户手动跳过，已写入 skipped review。', 'Skipped by user. A skipped-review artifact was saved.'),
          };
          this.announceReviewProgress(
            leadMeta.leadSlot,
            leadResolution,
            reviewSlots,
            reviewProgress,
            this.describeNextReviewAction(leadMeta.leadSlot, reviewSlots, reviewProgress),
          );
          continue;
        }

        this.reportModelFallback(
          'Review Routing',
          [
            `Review 角色：${ENGINE_LABELS[slot]}`,
            `Review 关注点：${ENGINE_STAGE_HINTS[slot]}`,
            '执行结果：未完成，已写入 fallback review，建议人工补看这一视角。',
          ].join('\n'),
          error,
          [
            `Review 角色：${ENGINE_LABELS[slot]}`,
            `Review 关注点：${ENGINE_STAGE_HINTS[slot]}`,
            `当前动作：${ENGINE_LABELS[slot]} 正在独立 review ${ENGINE_LABELS[leadMeta.leadSlot]} 主写的技术设计草稿。`,
            `执行限制：此阶段只允许 ${ENGINE_LABELS[slot]} 直连执行，不会自动切代理。`,
            `超时阈值：${this.formatDurationMs(this.config.timeouts.modelExecutionMs)}`,
          ].join('\n'),
        );
        const fallbackReview = this.buildFallbackReview(slot, error);
        this.store.saveJson(`review-${slot}.json`, fallbackReview);
        this.store.saveArtifact(`review-${slot}.md`, ConsensusEngine.renderReviewMarkdown(fallbackReview, this.config.language));
        reviews.push(fallbackReview);
        reviewProgress[slot] = {
          status: 'fallback',
          detail: this.copy('结构化 Review 未成功返回，已写入 fallback review。', 'Structured review unavailable; fallback review saved.'),
        };
        this.announceReviewProgress(
          leadMeta.leadSlot,
          leadResolution,
          reviewSlots,
          reviewProgress,
          this.describeNextReviewAction(leadMeta.leadSlot, reviewSlots, reviewProgress),
        );
      }
    }

    const consensus = ConsensusEngine.summarizeReviews(reviews, this.config.language);
    this.store.saveJson('consensus-report.json', consensus);
    this.store.saveArtifact('consensus-report.md', ConsensusEngine.renderConsensusMarkdown(consensus, reviews, this.config.language));
    this.store.markStage('stage3-reviews', 'completed', 'Independent reviews completed');
    return reviews;
  }

  private buildPrdReviewFallbackReview(slot: EngineSlot, error: unknown, targetFilePath: string): StructuredReview {
    const message = error instanceof Error ? error.message : String(error);
    const conciseMessage = truncate(message.replace(/\s+/g, ' ').trim(), 600);

    return {
      reviewer: slot,
      reviewerLabel: ENGINE_LABELS[slot],
      resolvedBy: slot,
      proxyUsed: false,
      lens: this.describePrdReviewLens(slot),
      verdict: 'Needs Discussion',
      summary: this.copy(
        `${ENGINE_LABELS[slot]} 未完成对 ${path.basename(targetFilePath)} 的独立 PRD 评审。建议降低自动化置信度，并人工补看这一评审视角。`,
        `${ENGINE_LABELS[slot]} did not complete an independent PRD review for ${path.basename(targetFilePath)}. Proceed with reduced confidence and inspect this lens manually.`,
      ),
      findings: [
        {
          title: this.copy('PRD 独立评审不可用', 'Independent PRD review unavailable'),
          severity: 'medium',
          confidence: 0.98,
          details: conciseMessage || this.copy(
            `${ENGINE_LABELS[slot]} 没有返回结构化 PRD 评审结果。`,
            `${ENGINE_LABELS[slot]} did not return a structured PRD review.`,
          ),
          recommendation: this.copy(
            '修复对应引擎问题后重新运行 `/reviewp`，或由人工从这个视角补充评审。',
            'Re-run `/reviewp` after fixing the engine issue, or complete a manual review from this lens.',
          ),
        },
      ],
      openQuestions: [
        this.copy(
          `在继续进入设计或实现前，是否需要补做一次“${this.describePrdReviewLens(slot)}”视角的 PRD 评审？`,
          `Should this PRD still be reviewed from the ${this.describePrdReviewLens(slot)} lens before moving into design or implementation?`,
        ),
      ],
      suggestedDecision: this.copy(
        '不要仅因为某个 reviewer 失败就直接否决 PRD，但应在继续推进前暴露这次缺失的评审视角。',
        'Do not reject the PRD solely because one reviewer failed, but surface the missing review lens before moving forward.',
      ),
      rawOutput: conciseMessage,
    };
  }

  private buildDesignReviewFallbackReview(slot: EngineSlot, error: unknown, targetFilePath: string): StructuredReview {
    const message = error instanceof Error ? error.message : String(error);
    const conciseMessage = truncate(message.replace(/\s+/g, ' ').trim(), 600);

    return {
      reviewer: slot,
      reviewerLabel: ENGINE_LABELS[slot],
      resolvedBy: slot,
      proxyUsed: false,
      lens: this.describeDesignReviewLens(slot),
      verdict: 'Needs Discussion',
      summary: this.copy(
        `${ENGINE_LABELS[slot]} 未完成对 ${path.basename(targetFilePath)} 的独立技术设计评审。建议降低自动化置信度，并人工补看这一评审视角。`,
        `${ENGINE_LABELS[slot]} did not complete an independent technical design review for ${path.basename(targetFilePath)}. Proceed with reduced confidence and inspect this lens manually.`,
      ),
      findings: [
        {
          title: this.copy('技术设计独立评审不可用', 'Independent technical design review unavailable'),
          severity: 'medium',
          confidence: 0.98,
          details: conciseMessage || this.copy(
            `${ENGINE_LABELS[slot]} 没有返回结构化技术设计评审结果。`,
            `${ENGINE_LABELS[slot]} did not return a structured technical design review.`,
          ),
          recommendation: this.copy(
            '修复对应引擎问题后重新运行 `/reviewd`，或由人工从这个视角补充评审。',
            'Re-run `/reviewd` after fixing the engine issue, or complete a manual review from this lens.',
          ),
        },
      ],
      openQuestions: [
        this.copy(
          `在继续进入实现前，是否需要补做一次“${this.describeDesignReviewLens(slot)}”视角的技术设计评审？`,
          `Should this technical design still be reviewed from the ${this.describeDesignReviewLens(slot)} lens before implementation starts?`,
        ),
      ],
      suggestedDecision: this.copy(
        '不要仅因为某个 reviewer 失败就直接否决技术设计，但应在继续推进前暴露这次缺失的评审视角。',
        'Do not reject the technical design solely because one reviewer failed, but surface the missing review lens before moving forward.',
      ),
      rawOutput: conciseMessage,
    };
  }

  private buildFallbackReview(slot: EngineSlot, error: unknown): StructuredReview {
    const message = error instanceof Error ? error.message : String(error);
    const conciseMessage = truncate(message.replace(/\s+/g, ' ').trim(), 600);

    return {
      reviewer: slot,
      reviewerLabel: ENGINE_LABELS[slot],
      resolvedBy: slot,
      proxyUsed: false,
      lens: ENGINE_LENSES[slot],
      verdict: 'Needs Discussion',
      summary: this.copy(
        `${ENGINE_LABELS[slot]} 未完成独立评审。建议降低自动化置信度；如果这份设计影响较大，请人工补看这一评审视角。`,
        `${ENGINE_LABELS[slot]} did not complete its independent review. Proceed with reduced confidence and inspect this lens manually if the design is high impact.`,
      ),
      findings: [
        {
          title: this.copy('独立评审不可用', 'Independent review unavailable'),
          severity: 'medium',
          confidence: 0.98,
          details: conciseMessage || this.copy(
            `${ENGINE_LABELS[slot]} 没有返回结构化评审结果。`,
            `${ENGINE_LABELS[slot]} did not return a structured review.`,
          ),
          recommendation: this.copy(
            '修复对应引擎问题后重新运行该评审，或在进入执行前由人工从这个视角补看设计。',
            'Re-run this reviewer after fixing the engine issue, or manually inspect the design from this lens before execution.',
          ),
        },
      ],
      openQuestions: [
        this.copy(
          `在开始实现前，是否需要从“${ENGINE_LENSES[slot]}”这个视角人工复核当前设计？`,
          `Should this design be manually reviewed from the ${ENGINE_LENSES[slot]} lens before implementation starts?`,
        ),
      ],
      suggestedDecision: this.copy(
        '不要仅因为某个评审器执行失败就完全阻塞流程，但需要在圆桌和交接产物中明确暴露这次缺失的评审。',
        'Do not block the pipeline solely on reviewer execution failure, but surface the missing review in roundtable and handoff artifacts.',
      ),
      rawOutput: conciseMessage,
    };
  }

  private buildSkippedReview(slot: EngineSlot): StructuredReview {
    return {
      reviewer: slot,
      reviewerLabel: ENGINE_LABELS[slot],
      resolvedBy: slot,
      proxyUsed: false,
      lens: ENGINE_LENSES[slot],
      verdict: 'Needs Discussion',
      summary: this.copy(
        `${ENGINE_LABELS[slot]} 这一轮独立评审由用户手动跳过。流程会继续推进，但当前设计缺少这个视角的自动评审意见。`,
        `${ENGINE_LABELS[slot]}'s independent review was skipped manually. The workflow continues, but this design is missing that automated review lens.`,
      ),
      findings: [
        {
          title: this.copy('独立评审被手动跳过', 'Independent review skipped manually'),
          severity: 'medium',
          confidence: 1,
          details: this.copy(
            `用户在等待 ${ENGINE_LABELS[slot]} 返回期间主动跳过了这一轮评审，因此没有生成结构化结论。`,
            `The user skipped this review while waiting for ${ENGINE_LABELS[slot]}, so no structured review conclusion was produced.`,
          ),
          recommendation: this.copy(
            '如果这个视角对后续实现风险较敏感，建议稍后单独重跑该 reviewer，或由人工从这个视角补看设计。',
            'If this lens is important to implementation risk, rerun this reviewer later or inspect the design manually from this perspective.',
          ),
        },
      ],
      openQuestions: [
        this.copy(
          `是否需要在开始实现前，补做一次“${ENGINE_LENSES[slot]}”视角的评审？`,
          `Should a ${ENGINE_LENSES[slot]} review still be completed before implementation starts?`,
        ),
      ],
      suggestedDecision: this.copy(
        '可以继续后续流程，但圆桌讨论和最终交接里需要明确说明这一轮评审是手动跳过的。',
        'Proceed if needed, but explicitly call out in the roundtable and handoff that this review was skipped manually.',
      ),
      rawOutput: this.copy(
        '用户在等待过程中手动跳过了当前 reviewer。',
        'The user manually skipped the current reviewer while waiting.',
      ),
    };
  }

  private async stage4Roundtable(reviews: StructuredReview[]): Promise<{ pausedForManualReview: boolean }> {
    this.store.markStage('stage4-roundtable', 'running');

    if (this.store.exists('tech-design-final.md')) {
      this.store.markStage('stage4-roundtable', 'completed', 'Recovered final design');
      return { pausedForManualReview: false };
    }

    const leadMeta = this.mustReadJson<{ leadSlot: EngineSlot }>('tech-design-lead.json');
    const participants = unique([leadMeta.leadSlot, ...reviews.map(review => review.reviewer)]);
    const manualReviewFeedback = this.store.readArtifact('manual-review-feedback.md')?.trim() || '';
    ChatUI.stage('Stage 4', [
      `圆桌参与：${participants.map(slot => ENGINE_LABELS[slot]).join(' / ')}`,
      this.formatSlotPreference('议题规划候选', this.stageSlotPreference('roundtablePlan')),
      '人工仲裁：用户',
      `定稿主写：${ENGINE_LABELS[leadMeta.leadSlot]}`,
      manualReviewFeedback ? '检测到历史人工复核意见：本轮会纳入再次讨论与定稿上下文。' : '',
    ]);
    const designDraft = this.mustReadArtifact('tech-design-draft.md');
    const consensus =
      this.store.readJson<ConsensusSummary>('consensus-report.json') || ConsensusEngine.summarizeReviews(reviews, this.config.language);

    let plan: RoundtablePlan;
    try {
      const prompt = [
        'You are facilitating an engineering roundtable.',
        'Given the independent reviews, decide whether a roundtable is required and define the exact issues to debate.',
        'Return JSON only.',
        '',
        `Reviews:\n${JSON.stringify(reviews, null, 2)}`,
        '',
        `Consensus summary:\n${JSON.stringify(consensus, null, 2)}`,
        manualReviewFeedback ? `\nManual review feedback:\n${manualReviewFeedback}` : '',
      ].join('\n');
      const result = await this.runWithLoading(
        {
          start: this.copy('正在整理评审分歧并规划圆桌议题...', 'Organizing review conflicts and planning roundtable topics...'),
          success: this.copy('圆桌议题已规划', 'Roundtable topics planned'),
          failure: this.copy('圆桌议题规划失败，将改用 Review 汇总兜底', 'Roundtable planning failed; falling back to review consensus'),
        },
        () => this.runJsonWithPreferredSlots<RoundtablePlan>(
          this.stageSlotPreference('roundtablePlan'),
          prompt,
          ROUNDTABLE_PLAN_SCHEMA,
        ),
      );
      plan = result.parsed;
      ChatUI.info('Roundtable Planning', this.formatRoutedExecution('议题规划', result.resolution, '冲突归纳 / 议题编排'));
    } catch (error) {
      this.reportModelFallback('Roundtable Planning', '议题规划：模型执行失败，已基于 Review 汇总结果生成兜底议题。', error);
      plan = {
        launchRoundtable: reviews.some(review => review.verdict !== 'Approve'),
        summary: consensus.summary,
        consensusPoints: consensus.consensusPoints,
        unresolvedQuestions: consensus.unresolvedQuestions,
        issues: consensus.conflicts,
      };
    }

    this.store.saveJson('roundtable-plan.json', plan);
    const turns: RoundtableTurn[] = [];

    if (plan.launchRoundtable && plan.issues.length > 0) {
      for (const issue of plan.issues) {
        ChatUI.info('Roundtable Topic', `${issue.question}\n\n${issue.whyItMatters}`);

        for (const round of [1, 2]) {
          for (const slot of participants) {
            const reviewForSlot = reviews.find(review => review.reviewer === slot);
            const priorTurns = turns.filter(turn => turn.issueId === issue.id && turn.round === 1);
            const prompt =
              round === 1
                ? [
                  `You are ${ENGINE_LABELS[slot]} in an AegisFlow roundtable.`,
                  `Lens: ${ENGINE_LENSES[slot]}.`,
                  `Issue: ${issue.question}`,
                  `Why it matters: ${issue.whyItMatters}`,
                  reviewForSlot ? `Your earlier review summary: ${reviewForSlot.summary}` : `You are the design lead for this issue.`,
                  `Available decision options: ${issue.options.map(option => option.label).join(' | ')}`,
                  manualReviewFeedback ? `Human manual review feedback:\n${manualReviewFeedback}` : '',
                  'Respond in plain text with your position, strongest reason, top risk, and preferred option. Keep it under 180 words.',
                ].join('\n')
                : [
                  `You are ${ENGINE_LABELS[slot]} in round 2 of the AegisFlow roundtable.`,
                  `Issue: ${issue.question}`,
                  `Round 1 transcript:\n${priorTurns.map(turn => `${turn.agentLabel}: ${turn.message}`).join('\n\n')}`,
                  manualReviewFeedback ? `Human manual review feedback:\n${manualReviewFeedback}` : '',
                  'Respond with: what you agree with, what still worries you, and your final recommendation. Keep it under 150 words.',
                ].join('\n');

            const result = await this.runWithLoading(
              {
                start: this.copy(
                  `正在等待 ${ENGINE_LABELS[slot]} 进行第 ${round} 轮发言...`,
                  `Waiting for ${ENGINE_LABELS[slot]} to deliver round ${round} commentary...`,
                ),
                success: this.copy(
                  `${ENGINE_LABELS[slot]} 的第 ${round} 轮发言已收到`,
                  `${ENGINE_LABELS[slot]}'s round ${round} commentary received`,
                ),
                failure: this.copy(
                  `${ENGINE_LABELS[slot]} 的第 ${round} 轮发言失败`,
                  `${ENGINE_LABELS[slot]}'s round ${round} commentary failed`,
                ),
              },
              () => this.withTransientHealth(() =>
                this.runTextForSlot(slot, prompt, {
                  timeoutMs: this.config.timeouts.modelExecutionMs,
                  allowFallbackProxy: true,
                }),
              ),
            );
            const turn: RoundtableTurn = {
              round,
              issueId: issue.id,
              agent: slot,
              agentLabel: ENGINE_LABELS[slot],
              resolvedBy: result.resolution.resolvedBy,
              proxyUsed: result.resolution.proxyUsed,
              message: result.output.stdout.trim() || `${ENGINE_LABELS[slot]} could not respond in time.`,
            };
            turns.push(turn);

            const color =
              slot === 'codex' ? chalk.cyan : slot === 'gemini' ? chalk.green : chalk.magenta;
            await ChatUI.renderRoundtableMessage(this.formatRoundtableSpeakerLabel(turn), turn.message, color);
      }
    }
  }

    } else {
      const leadTurn: RoundtableTurn = {
        round: 1,
        issueId: 'no-conflict',
        agent: leadMeta.leadSlot,
        agentLabel: ENGINE_LABELS[leadMeta.leadSlot],
        resolvedBy: leadMeta.leadSlot,
        proxyUsed: false,
        message: this.copy(
          '独立评审没有发现阻塞性的架构冲突，继续进入技术设计定稿。',
          'Independent reviews did not uncover a blocking architectural conflict. Proceeding to finalize the design.',
        ),
      };
      turns.push(leadTurn);
      await ChatUI.renderRoundtableMessage(leadTurn.agentLabel, leadTurn.message, chalk.magenta);
    }

    this.store.saveJson('roundtable-turns.json', turns);
    this.store.saveArtifact(
      'roundtable-transcript.md',
      ConsensusEngine.renderRoundtableTranscript(plan, turns, this.config.language),
    );

    let minutes: RoundtableMinutes;
    try {
      const prompt = [
        'You are summarizing an AegisFlow roundtable.',
        'Return JSON only with a short summary, 2-4 decision options, recommendations, and unresolved risks.',
        '',
        `Technical design draft:\n${designDraft}`,
        '',
        `Roundtable plan:\n${JSON.stringify(plan, null, 2)}`,
        '',
        `Transcript:\n${JSON.stringify(turns, null, 2)}`,
        manualReviewFeedback ? `\nManual review feedback:\n${manualReviewFeedback}` : '',
      ].join('\n');
      const result = await this.runWithLoading(
        {
          start: this.copy('正在汇总圆桌讨论并生成会议纪要...', 'Summarizing the roundtable discussion into minutes...'),
          success: this.copy('圆桌纪要已生成', 'Roundtable minutes generated'),
          failure: this.copy('圆桌纪要生成失败，将改用现有信息兜底', 'Roundtable minutes failed; falling back to the current discussion state'),
        },
        () => this.runJsonWithPreferredSlots<RoundtableMinutes>(
          this.stageSlotPreference('roundtableMinutes'),
          prompt,
          ROUNDTABLE_MINUTES_SCHEMA,
        ),
      );
      minutes = result.parsed;
      ChatUI.info('Roundtable Minutes', this.formatRoutedExecution('会议纪要整理', result.resolution, '观点收束 / 决策选项整理'));
    } catch (error) {
      this.reportModelFallback('Roundtable Minutes', '会议纪要整理：模型执行失败，已基于现有圆桌信息生成兜底纪要。', error);
      minutes = {
        summary: plan.summary,
        decisionOptions:
          plan.issues.flatMap(issue => issue.options).length > 0
            ? plan.issues.flatMap(issue => issue.options)
            : [{
              value: 'proceed',
              label: this.copy('按当前设计继续推进', 'Proceed with current design'),
              rationale: this.copy('未检测到阻塞性冲突。', 'No blocking conflicts detected.'),
            }],
        recommendations: consensus.consensusPoints,
        unresolvedRisks: consensus.unresolvedQuestions,
      };
    }

    this.store.saveJson('roundtable-minutes.json', minutes);
    this.store.saveArtifact('roundtable-minutes.md', ConsensusEngine.renderRoundtableMinutes(minutes, this.config.language));
    const reviewPacketPath = this.store.getArtifactPath('tech-design-review-packet.md');
    this.store.saveArtifact(
      'tech-design-review-packet.md',
      this.buildTechDesignReviewPacket(designDraft, reviews, consensus, plan, minutes, manualReviewFeedback),
    );
    ChatUI.showArtifact(
      'Tech Design Review Packet Preview',
      [
        '请先查看完整技术设计复核包，再选择最终方案。',
        `技术设计草稿：${this.store.getArtifactPath('tech-design-draft.md')}`,
        `独立评审汇总：${this.store.getArtifactPath('consensus-report.md')}`,
        `圆桌纪要：${this.store.getArtifactPath('roundtable-minutes.md')}`,
        manualReviewFeedback ? `已纳入的人工复核意见：${this.store.getArtifactPath('manual-review-feedback.md')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      reviewPacketPath,
    );
    await ChatUI.inspectArtifact('Tech Design Review Packet', reviewPacketPath);

    const decision = await ChatUI.askRoundtableDecision(
      minutes.decisionOptions.map(option => ({ value: option.value, label: option.label })),
    );

    const decisionMeta = minutes.decisionOptions.find(option => option.value === decision);
    this.store.saveJson('decision-log.json', {
      selected: decision,
      selectedLabel: decisionMeta?.label || decision,
      selectedRationale: decisionMeta?.rationale || '',
      decidedAt: nowIso(),
    });
    this.store.saveArtifact(
      'decision-log.md',
      [
        `# ${this.copy('决策记录', 'Decision Log')}`,
        '',
        `- ${this.copy('决策', 'Decision')}: ${decisionMeta?.label || decision}`,
        `- ${this.copy('原因', 'Rationale')}: ${decisionMeta?.rationale || this.copy('无', 'N/A')}`,
        `- ${this.copy('时间', 'Time')}: ${nowIso()}`,
        '',
      ].join('\n'),
    );
    ChatUI.info(
      'Decision Captured',
      [
        `已记录最终方案：${decisionMeta?.label || decision}`,
        decisionMeta?.rationale ? `选择原因：${decisionMeta.rationale}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    if (this.isManualReviewPauseDecision(decisionMeta || { value: decision, label: decision, rationale: '' })) {
      let latestManualReviewFeedbackPath = manualReviewFeedback
        ? this.store.getArtifactPath('manual-review-feedback.md')
        : '';
      const captureFeedback = await ChatUI.confirm(
        this.copy(
          '是否现在记录人工复核意见，供后续再次讨论或定稿时自动带入？',
          'Would you like to record manual review feedback now so it is included in the next discussion or finalization run?',
        ),
        true,
      );

      if (captureFeedback) {
        const feedback = await ChatUI.askRevisionRequest('技术设计');
        latestManualReviewFeedbackPath = this.appendManualReviewFeedback(feedback);
        this.store.appendArtifact('approval-log.md', `[${nowIso()}] Tech design manual review note: ${feedback}\n`);
        this.store.saveArtifact(
          'tech-design-review-packet.md',
          this.buildTechDesignReviewPacket(
            designDraft,
            reviews,
            consensus,
            plan,
            minutes,
            this.store.readArtifact('manual-review-feedback.md')?.trim() || '',
          ),
        );
      }

      const manualReviewPath = this.store.getArtifactPath('manual-review-handoff.md');
      this.store.saveArtifact(
        'manual-review-handoff.md',
        [
          `# ${this.copy('人工复核暂停', 'Manual Review Pause')}`,
          '',
          `- ${this.copy('决策', 'Decision')}: ${decisionMeta?.label || decision}`,
          `- ${this.copy('原因', 'Rationale')}: ${decisionMeta?.rationale || this.copy('无', 'N/A')}`,
          `- ${this.copy('时间', 'Time')}: ${nowIso()}`,
          '',
          `## ${this.copy('完整复核材料', 'Full Review Materials')}`,
          `- ${this.copy('技术设计复核包', 'Technical design review packet')}: ${reviewPacketPath}`,
          `- ${this.copy('技术设计草稿全文', 'Technical design draft')}: ${this.store.getArtifactPath('tech-design-draft.md')}`,
          `- ${this.copy('独立评审汇总', 'Consensus report')}: ${this.store.getArtifactPath('consensus-report.md')}`,
          `- ${this.copy('圆桌纪要', 'Roundtable minutes')}: ${this.store.getArtifactPath('roundtable-minutes.md')}`,
          latestManualReviewFeedbackPath
            ? `- ${this.copy('人工复核意见', 'Manual review feedback')}: ${latestManualReviewFeedbackPath}`
            : '',
          '',
          `## ${this.copy('建议人工重点复核', 'Recommended Manual Review Focus')}`,
          ...(minutes.recommendations.length > 0
            ? minutes.recommendations.map(item => `- ${item}`)
            : [`- ${this.copy('无', 'None')}`]),
          '',
          `## ${this.copy('未解决风险', 'Unresolved Risks')}`,
          ...(minutes.unresolvedRisks.length > 0
            ? minutes.unresolvedRisks.map(item => `- ${item}`)
            : [`- ${this.copy('无', 'None')}`]),
          '',
          `## ${this.copy('恢复执行建议', 'Resume Guidance')}`,
          `- ${this.copy('继续之前先阅读圆桌纪要和这份交接说明。', 'Review the roundtable minutes and this handoff before continuing.')}`,
          `- ${this.copy('更新技术设计草稿，或补充人工复核结论，然后重新执行 Stage 4 产出设计定稿。', 'Update the technical design draft or capture review conclusions, then re-run Stage 4 to produce a final design.')}`,
          '',
        ].join('\n'),
      );
      ChatUI.info(
        'Manual Review Pause',
        [
          '已按你的选择暂停后续自动执行，不会继续进入任务拆分与编码。',
          `完整技术设计复核包：${reviewPacketPath}`,
          `人工复核说明：${manualReviewPath}`,
          `圆桌纪要：${this.store.getArtifactPath('roundtable-minutes.md')}`,
          latestManualReviewFeedbackPath ? `人工复核意见：${latestManualReviewFeedbackPath}` : '',
        ].join('\n'),
      );
      this.store.markStage('stage4-roundtable', 'completed', 'Paused for manual review after human decision');
      return { pausedForManualReview: true };
    }

    const finalPrompt = [
      'You are finalizing the technical design after a human arbitration decision.',
      'Update the original technical design to reflect the selected decision and the roundtable recommendations.',
      'Return markdown only.',
      'Do not wrap the answer in triple backticks.',
      'Do not add any explanation before the document.',
      '',
      `Original draft:\n${designDraft}`,
      '',
      `Roundtable minutes:\n${JSON.stringify(minutes, null, 2)}`,
      '',
      `Selected decision:\n${JSON.stringify(decisionMeta || { value: decision }, null, 2)}`,
      manualReviewFeedback ? `\nManual review feedback:\n${manualReviewFeedback}` : '',
    ].join('\n');

    const finalDesignSpinner = ChatUI.showProgress('正在根据人工裁决生成技术设计定稿...');
    let finalDesign;
    try {
      finalDesign = await this.runTextWithPreferredSlots(
        this.buildSlotPreference(leadMeta.leadSlot, 'finalDesign'),
        finalPrompt,
      );
      finalDesignSpinner.stop('技术设计定稿已生成');
    } catch (error) {
      finalDesignSpinner.error('技术设计定稿生成失败');
      throw error;
    }
    ChatUI.info('Final Design Routing', this.formatExecutionSummary('定稿主写', leadMeta.leadSlot, finalDesign.resolution));
    this.store.saveArtifact('tech-design-final.md', normalizeMarkdownDocument(finalDesign.output.stdout));
    this.store.markStage('stage4-roundtable', 'completed', 'Human decision captured and final design generated');
    return { pausedForManualReview: false };
  }

  private async stagePostDesignDecision(): Promise<DevelopmentStrategy> {
    this.store.markStage('stage4-post-design-decision', 'running');

    const existing = this.store.readJson<DevelopmentStrategy>('development-strategy.json');
    if (existing) {
      this.store.markStage('stage4-post-design-decision', 'completed', 'Recovered development strategy');
      return existing;
    }

    ChatUI.stage('Post-Design', [
      '技术设计已完成，请决定是否立即进入开发。',
      '若选择单一终端，任务拆分、编码执行、集成复核都会固定使用同一个程序。',
      '若选择多终端，会按任务 Owner / Reviewer 分工协作，例如 Gemini 前端、Codex 后端、Claude Review。',
    ]);

    const action = await ChatUI.askPostDesignAction();
    const actionLabel = action === 'start_development' ? '立即开始开发' : '先停在技术设计阶段';

    let strategy: DevelopmentStrategy = {
      action,
      actionLabel,
      decidedAt: nowIso(),
    };

    if (action === 'start_development') {
      const mode = await ChatUI.askDevelopmentMode();
      const modeLabel = mode === 'single_terminal' ? '单一终端开发' : '多终端协作开发';

      strategy = {
        ...strategy,
        mode,
        modeLabel,
      };

      if (mode === 'single_terminal') {
        const engineOptions = this.availableEngineOptionsForSingleTerminal();
        const engine = await ChatUI.askSingleTerminalEngine(engineOptions);
        strategy = {
          ...strategy,
          singleTerminalEngine: engine as EngineSlot,
          singleTerminalEngineLabel: ENGINE_LABELS[engine as EngineSlot],
        };
      }
    }

    this.store.saveJson('development-strategy.json', strategy);
    this.store.saveArtifact('development-strategy.md', this.renderDevelopmentStrategyMarkdown(strategy));
    ChatUI.info('Development Strategy', this.describeDevelopmentStrategy(strategy));
    this.store.markStage('stage4-post-design-decision', 'completed', strategy.actionLabel);
    return strategy;
  }

  private async stage5TaskPlan(strategy: DevelopmentStrategy): Promise<TaskGraph> {
    this.store.markStage('stage5-task-plan', 'running');

    if (this.store.exists('task-graph.json') && this.store.exists('implementation-plan.md')) {
      this.store.markStage('stage5-task-plan', 'completed', 'Recovered existing task plan');
      return this.mustReadJson<TaskGraph>('task-graph.json');
    }

    ChatUI.stage('Stage 5', [
      this.isSingleTerminalMode(strategy)
        ? `任务拆分执行：${strategy.singleTerminalEngineLabel}（固定单终端）`
        : this.formatSlotPreference('任务拆分候选', this.stageSlotPreference('taskPlan')),
      '输出：任务列表、依赖关系、Owner、Reviewer',
      this.isSingleTerminalMode(strategy)
        ? '说明：所有任务会固定分配给同一个终端程序，不再做多程序分工。'
        : '说明：后续编码阶段会按这里的 owner / reviewer 执行与展示。',
    ]);
    const design = this.mustReadArtifact('tech-design-final.md');
    const repoFiles = Object.keys(captureWorkspaceSnapshot(process.cwd()).files).slice(0, 200);

    const prompt = [
      'You are an engineering manager preparing implementation tickets.',
      'Split the work into 4-10 concrete tasks.',
      'Return JSON only.',
      'Tasks must include dependency links, acceptance criteria, preferred owner and preferred reviewer.',
      'For each task, include concrete files, 3-6 implementationSteps, 2-4 verificationSteps, 1-3 reviewFocus items, and a suggestedCommitMessage.',
      'Prefer exact file paths and explicit verification commands when the repository context makes them obvious.',
      this.isSingleTerminalMode(strategy)
        ? `The user selected single-terminal development, so every task owner and reviewer must be ${strategy.singleTerminalEngine}.`
        : 'The user selected multi-terminal development, so assign owners and reviewers by domain fit.',
      '',
      `Technical design:\n${design}`,
      '',
      `Current repository files:\n${repoFiles.join('\n')}`,
    ].join('\n');

    let taskGraph: TaskGraph;
    try {
      if (this.isSingleTerminalMode(strategy)) {
        const result = await this.runWithLoading(
          {
            start: this.copy('正在拆分任务并安排执行顺序...', 'Splitting the work into implementation tasks...'),
            success: this.copy('任务计划已生成', 'Task plan generated'),
            failure: this.copy('任务计划生成失败，将改用兜底任务图', 'Task planning failed; falling back to a heuristic task graph'),
          },
          () => this.withTransientHealth(() => this.runJsonForSlot<{ tasks: TaskNode[] }>(
            this.singleTerminalEngineOrThrow(strategy),
            prompt,
            TASK_GRAPH_SCHEMA,
            {
              timeoutMs: this.config.timeouts.modelExecutionMs,
              allowFallbackProxy: false,
            },
          )),
        );
        ChatUI.info('Task Planning Routing', this.formatRoutedExecution('任务拆分', result.resolution, '任务切分 / owner-reviewer 分配'));
        taskGraph = this.normalizeTaskGraph(((result.output.parsed as { tasks: TaskNode[] })?.tasks) || []);
      } else {
        const result = await this.runWithLoading(
          {
            start: this.copy('正在拆分任务并安排执行顺序...', 'Splitting the work into implementation tasks...'),
            success: this.copy('任务计划已生成', 'Task plan generated'),
            failure: this.copy('任务计划生成失败，将改用兜底任务图', 'Task planning failed; falling back to a heuristic task graph'),
          },
          () => this.runJsonWithPreferredSlots<{ tasks: TaskNode[] }>(
            this.stageSlotPreference('taskPlan'),
            prompt,
            TASK_GRAPH_SCHEMA,
          ),
        );
        ChatUI.info('Task Planning Routing', this.formatRoutedExecution('任务拆分', result.resolution, '任务切分 / owner-reviewer 分配'));
        taskGraph = this.normalizeTaskGraph(result.parsed.tasks);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.saveArtifact(
        'task-plan-fallback-reason.md',
        `# ${this.copy('任务规划兜底说明', 'Task Planning Fallback')}\n\n${message}\n`,
      );
      ChatUI.info(
        'Task Planning Routing',
        [
          '任务拆分：模型执行失败，已基于仓库结构生成兜底任务计划。',
          `错误摘要：${truncate(message.replace(/\s+/g, ' ').trim(), 320)}`,
        ].join('\n'),
      );
      this.debugModelFailure('Task Planning Routing', error);
      taskGraph = this.buildFallbackTaskGraph(repoFiles);
    }

    taskGraph = this.applyDevelopmentStrategyToTaskGraph(taskGraph, strategy);
    ChatUI.info('Task Assignment', this.summarizeTaskAssignments(taskGraph));
    this.store.saveJson('task-graph.json', taskGraph);
    this.store.saveArtifact('implementation-plan.md', ConsensusEngine.renderImplementationPlan(taskGraph, this.config.language));
    this.store.markStage(
      'stage5-task-plan',
      'completed',
      this.store.exists('task-plan-fallback-reason.md')
        ? this.copy('已生成兜底任务图', 'Fallback task graph created')
        : this.copy('已生成任务图', 'Task graph created'),
    );
    return taskGraph;
  }

  private async stage6Execution(taskGraph: TaskGraph, strategy: DevelopmentStrategy) {
    this.store.markStage('stage6-execution', 'running');
    ChatUI.stage('Stage 6', [
      this.isSingleTerminalMode(strategy)
        ? `编码执行：全部任务固定由 ${strategy.singleTerminalEngineLabel} 处理`
        : '编码执行：按任务计划中的 Owner 路由',
      this.isSingleTerminalMode(strategy)
        ? '结果复核：沿用同一终端，不再切换到其他程序'
        : '结果复核：参考任务计划中的 Reviewer',
      this.describeTaskExecutionSessionMode(strategy),
      this.isSingleTerminalMode(strategy)
        ? '说明：单一终端模式下不会代理到其他程序，失败会直接记录到任务结果。'
        : '说明：若 Owner 不可用，会自动代理执行，但保留原始 Owner 角色。',
    ]);
    ChatUI.info('Execution Queue', this.summarizeTaskAssignments(taskGraph));

    const design = this.mustReadArtifact('tech-design-final.md');

    for (const taskId of taskGraph.executionOrder) {
      const task = taskGraph.tasks.find(item => item.id === taskId);
      if (!task) {
        continue;
      }

      if (this.store.exists(`task-runs/${task.id}.json`)) {
        continue;
      }

      const spinner = this.shouldUseInteractiveTaskSession(task.recommendedOwner)
        ? null
        : ChatUI.showProgress(`Executing ${task.id} with ${ENGINE_LABELS[task.recommendedOwner]}...`);

      try {
        const record = await this.executeTaskWithReview(task, design, strategy);
        this.store.saveJson(`task-runs/${task.id}.json`, record);
        this.store.saveArtifact(`task-runs/${task.id}.md`, this.buildTaskRunMarkdown(task, record));
        if (record.review) {
          this.store.saveArtifact(`task-runs/${task.id}.review.md`, this.buildTaskReviewMarkdown(task, record.review));
        }

        if (record.status === 'failed') {
          spinner?.error(`${task.id} failed`);
        } else {
          spinner?.stop(`${task.id} ${record.status}`);
        }

        ChatUI.info('Task Routing', this.formatTaskRunSummary(task, record));
        if (record.review) {
          ChatUI.info('Task Review', this.formatTaskReviewSummary(task, record.review));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const record: TaskRunRecord = {
          taskId: task.id,
          owner: task.recommendedOwner,
          reviewer: task.recommendedReviewer,
          resolvedBy: task.recommendedOwner,
          proxyUsed: false,
          status: 'failed',
          exitCode: 1,
          startedAt: nowIso(),
          finishedAt: nowIso(),
          changedFiles: [],
          summary: message,
          rawOutput: message,
        };
        this.store.saveJson(`task-runs/${task.id}.json`, record);
        this.store.saveArtifact(`task-runs/${task.id}.md`, this.buildTaskRunMarkdown(task, record));
        spinner?.error(`${task.id} failed`);
        ChatUI.info('Task Routing', this.formatTaskRunSummary(task, record));
      }
    }

    this.store.markStage('stage6-execution', 'completed', 'Task execution finished');
  }

  private async stage7Integration(taskGraph: TaskGraph, strategy: DevelopmentStrategy) {
    this.store.markStage('stage7-integration', 'running');
    ChatUI.stage('Stage 7', [
      this.isSingleTerminalMode(strategy)
        ? `集成复核：${strategy.singleTerminalEngineLabel}（固定单终端）`
        : this.formatSlotPreference('集成复核候选', this.stageSlotPreference('integrationReview')),
      '本地检查：自动运行 typecheck / build / test（若仓库存在）',
      '输出：集成复核、交付总结、最终 handoff',
    ]);

    const taskRuns = taskGraph.tasks
      .map(task => this.store.readJson<TaskRunRecord>(`task-runs/${task.id}.json`))
      .filter((item): item is TaskRunRecord => Boolean(item));

    const checks = await this.runWithLoading(
      {
        start: this.copy('正在运行本地检查（typecheck / build / test）...', 'Running local checks (typecheck / build / test)...'),
        success: this.copy('本地检查已完成', 'Local checks completed'),
        failure: this.copy('本地检查执行失败，将继续汇总已有结果', 'Local checks failed; continuing with the captured results'),
      },
      () => this.runLocalChecks(),
    );
    ChatUI.info('Local Checks', this.summarizeLocalChecks(checks));
    const changedFiles = diffSnapshots(this.initialSnapshot, captureWorkspaceSnapshot(process.cwd()));

    let review: IntegrationReview;
    try {
      const prompt = [
        'You are the final integration reviewer for AegisFlow.',
        'Assess the completed task runs and local check results.',
        'Return JSON only.',
        this.isSingleTerminalMode(strategy)
          ? `The user selected single-terminal development, so keep the review grounded in the ${strategy.singleTerminalEngine} execution path.`
          : 'The user selected multi-terminal development, so review cross-role coordination and handoff quality.',
        '',
        `Task graph:\n${JSON.stringify(taskGraph, null, 2)}`,
        '',
        `Task runs:\n${JSON.stringify(taskRuns, null, 2)}`,
        '',
        `Local checks:\n${JSON.stringify(checks, null, 2)}`,
        '',
        `Changed files:\n${changedFiles.join('\n')}`,
      ].join('\n');

      if (this.isSingleTerminalMode(strategy)) {
        const result = await this.runWithLoading(
          {
            start: this.copy('正在做最终集成复核并收口风险...', 'Running the final integration review and closing out risks...'),
            success: this.copy('集成复核已完成', 'Integration review completed'),
            failure: this.copy('集成复核失败，将改用本地兜底总结', 'Integration review failed; falling back to a local summary'),
          },
          () => this.withTransientHealth(() => this.runJsonForSlot<IntegrationReview>(
            this.singleTerminalEngineOrThrow(strategy),
            prompt,
            INTEGRATION_REVIEW_SCHEMA,
            {
              timeoutMs: this.config.timeouts.modelExecutionMs,
              allowFallbackProxy: false,
            },
          )),
        );
        review = result.output.parsed as IntegrationReview;
        ChatUI.info('Integration Routing', this.formatRoutedExecution('集成复核', result.resolution, '最终验收 / 风险收口'));
      } else {
        const result = await this.runWithLoading(
          {
            start: this.copy('正在做最终集成复核并收口风险...', 'Running the final integration review and closing out risks...'),
            success: this.copy('集成复核已完成', 'Integration review completed'),
            failure: this.copy('集成复核失败，将改用本地兜底总结', 'Integration review failed; falling back to a local summary'),
          },
          () => this.runJsonWithPreferredSlots<IntegrationReview>(
            this.stageSlotPreference('integrationReview'),
            prompt,
            INTEGRATION_REVIEW_SCHEMA,
          ),
        );
        review = result.parsed;
        ChatUI.info('Integration Routing', this.formatRoutedExecution('集成复核', result.resolution, '最终验收 / 风险收口'));
      }
    } catch (error) {
      this.reportModelFallback('Integration Routing', '集成复核：模型执行失败，已基于任务结果和本地检查生成兜底交付总结。', error);
      review = this.buildFallbackIntegrationReview(taskGraph, taskRuns, checks);
    }

    this.store.saveJson('integration-review.json', review);
    this.store.saveArtifact('integration-review.md', ConsensusEngine.renderIntegrationReview(review, checks, this.config.language));
    this.store.saveArtifact(
      'delivery-summary.md',
      ConsensusEngine.renderDeliverySummary(review, taskGraph, taskRuns, changedFiles, this.config.language),
    );
    this.store.saveArtifact('final-handoff.md', ConsensusEngine.renderFinalHandoff(review, checks, this.config.language));
    this.store.markStage('stage7-integration', 'completed', this.copy('已生成最终交接', 'Final handoff generated'));
  }

  private async executeTaskWithReview(
    task: TaskNode,
    design: string,
    strategy: DevelopmentStrategy,
  ): Promise<TaskRunRecord> {
    const startedAt = nowIso();
    const before = captureWorkspaceSnapshot(process.cwd());
    const liveTaskSession = this.shouldUseInteractiveTaskSession(task.recommendedOwner);
    if (!liveTaskSession) {
      this.maybeAnnounceInteractiveTaskDowngrade(task.recommendedOwner);
    }

    const initialAttempt = await this.runTaskImplementationAttempt(task, design, strategy, {
      interactiveSession: liveTaskSession,
      announceLiveSession: liveTaskSession,
    });

    let finalAttempt = initialAttempt;
    let changedFiles = diffSnapshots(before, captureWorkspaceSnapshot(process.cwd()));
    let review: TaskReviewRecord | undefined;

    if (initialAttempt.output.exitCode === 0) {
      review = await this.runTaskReview(task, design, changedFiles, initialAttempt.output.stdout, strategy, 1, [
        initialAttempt.resolution.resolvedBy,
      ]);

      if (review.status === 'needs_changes') {
        ChatUI.info(
          'Task Review',
          this.copy(
            `${task.id} 复核要求修正，正在安排一次带问题单的补改。`,
            `${task.id} needs follow-up changes from review. Running one remediation pass.`,
          ),
        );

        finalAttempt = await this.runTaskImplementationAttempt(task, design, strategy, {
          review,
          interactiveSession: false,
          announceLiveSession: false,
        });
        changedFiles = diffSnapshots(before, captureWorkspaceSnapshot(process.cwd()));

        if (finalAttempt.output.exitCode === 0) {
          review = await this.runTaskReview(task, design, changedFiles, finalAttempt.output.stdout, strategy, 2, [
            finalAttempt.resolution.resolvedBy,
          ]);
        }
      }
    }

    const status = this.deriveTaskStatus(finalAttempt.output.exitCode, changedFiles, review);

    return {
      taskId: task.id,
      owner: task.recommendedOwner,
      reviewer: task.recommendedReviewer,
      resolvedBy: finalAttempt.resolution.resolvedBy,
      proxyUsed: finalAttempt.resolution.proxyUsed,
      status,
      exitCode: finalAttempt.output.exitCode,
      startedAt,
      finishedAt: nowIso(),
      changedFiles,
      summary: this.buildTaskOutcomeSummary(finalAttempt.output.stdout, review, status),
      rawOutput: finalAttempt.output.stdout,
      review,
    };
  }

  private async runTaskImplementationAttempt(
    task: TaskNode,
    design: string,
    strategy: DevelopmentStrategy,
    options: {
      review?: TaskReviewRecord;
      interactiveSession: boolean;
      announceLiveSession: boolean;
    },
  ): Promise<{ resolution: SlotResolution; output: CLIExecutionResult<string> }> {
    if (options.announceLiveSession) {
      ChatUI.info(
        'Live Task Session',
        [
          `任务：${task.id} - ${task.title}`,
          `建议执行程序：${ENGINE_LABELS[task.recommendedOwner]}`,
          '接下来会进入实时终端会话。',
          '如果程序请求执行命令、写入文件或其他敏感操作，请直接在终端里手动确认或拒绝。',
          '如需中断当前子进程，可使用 Ctrl+C。',
        ].join('\n'),
      );
    }

    const prompt = options.review
      ? this.buildTaskRemediationPrompt(task, design, options.review)
      : this.buildTaskExecutionPrompt(task, design);

    return this.withTransientHealth(() =>
      this.runTextForSlot(task.recommendedOwner, prompt, {
        allowEdits: true,
        interactiveSession: options.interactiveSession,
        timeoutMs: undefined,
        allowEmptyOutput: true,
        allowFallbackProxy: this.isSingleTerminalMode(strategy) ? false : true,
      }),
    );
  }

  private buildTaskExecutionPrompt(task: TaskNode, design: string): string {
    return [
      `You are ${ENGINE_LABELS[task.recommendedOwner]} executing a concrete task inside the current repository.`,
      'You must modify files directly on disk if changes are needed.',
      'Keep the work tightly scoped to this task and do not quietly expand into adjacent tasks.',
      'Return a concise markdown summary covering what changed, verification performed, and any remaining risks.',
      '',
      `Task ID: ${task.id}`,
      `Title: ${task.title}`,
      `Domain: ${task.domain}`,
      `Description: ${task.description}`,
      `Depends On: ${task.dependsOn.join(', ') || 'None'}`,
      `Acceptance Criteria:\n- ${task.acceptanceCriteria.join('\n- ') || 'None'}`,
      `Implementation Steps:\n- ${task.implementationSteps.join('\n- ') || 'None'}`,
      `Verification Steps:\n- ${task.verificationSteps.join('\n- ') || 'None'}`,
      `Likely Files:\n- ${task.filesToTouch.join('\n- ') || 'Not specified'}`,
      `Suggested Commit Message: ${task.suggestedCommitMessage}`,
      '',
      `Final technical design:\n${design}`,
    ].join('\n');
  }

  private buildTaskRemediationPrompt(task: TaskNode, design: string, review: TaskReviewRecord): string {
    const findings = review.findings.length > 0
      ? review.findings.map(item => `- ${item.title}: ${item.details} | Recommendation: ${item.recommendation}`).join('\n')
      : '- Reviewer requested targeted follow-up without structured findings.';

    return [
      `You are ${ENGINE_LABELS[task.recommendedOwner]} revising a task implementation based on reviewer feedback.`,
      'Modify files directly on disk to resolve the reviewer findings.',
      'Stay within the original task boundary and do not add unrelated improvements.',
      'Return a concise markdown summary covering what changed, verification performed, and any remaining risks.',
      '',
      `Task ID: ${task.id}`,
      `Title: ${task.title}`,
      `Acceptance Criteria:\n- ${task.acceptanceCriteria.join('\n- ') || 'None'}`,
      `Verification Steps:\n- ${task.verificationSteps.join('\n- ') || 'None'}`,
      `Likely Files:\n- ${task.filesToTouch.join('\n- ') || 'Not specified'}`,
      '',
      `Reviewer Summary:\n${review.summary}`,
      `Required Fixes:\n${findings}`,
      review.openQuestions.length > 0 ? `Open Questions:\n- ${review.openQuestions.join('\n- ')}` : '',
      '',
      `Final technical design:\n${design}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async runTaskReview(
    task: TaskNode,
    design: string,
    changedFiles: string[],
    ownerSummary: string,
    strategy: DevelopmentStrategy,
    round: number,
    avoidTargets: EngineSlot[],
  ): Promise<TaskReviewRecord> {
    const filesForReview = unique([...changedFiles, ...task.filesToTouch]);
    const prompt = [
      `You are ${ENGINE_LABELS[task.recommendedReviewer]} reviewing a completed task implementation inside the current repository.`,
      'Review for task compliance first, then code quality.',
      'Inspect the repository as needed. Prefer needs_changes when acceptance criteria are not clearly met or when there is a meaningful correctness, test, or maintainability issue.',
      'Return JSON only.',
      '',
      `Task ID: ${task.id}`,
      `Title: ${task.title}`,
      `Domain: ${task.domain}`,
      `Description: ${task.description}`,
      `Acceptance Criteria:\n- ${task.acceptanceCriteria.join('\n- ') || 'None'}`,
      `Verification Expectations:\n- ${task.verificationSteps.join('\n- ') || 'None'}`,
      `Reviewer Focus:\n- ${task.reviewFocus.join('\n- ') || 'None'}`,
      `Changed Files:\n- ${filesForReview.join('\n- ') || 'No changed files detected'}`,
      '',
      `Owner summary:\n${truncate(ownerSummary, 3200)}`,
      '',
      `Current file snapshots:\n${this.buildTaskFileContext(filesForReview)}`,
      '',
      `Final technical design:\n${design}`,
    ].join('\n');

    try {
      const result = await this.withTransientHealth(() =>
        this.runJsonForSlot<{
          decision: 'approve' | 'needs_changes';
          summary: string;
          findings: TaskReviewRecord['findings'];
          openQuestions: string[];
        }>(task.recommendedReviewer, prompt, TASK_EXECUTION_REVIEW_SCHEMA, {
          timeoutMs: this.config.timeouts.modelExecutionMs,
          avoidTargets: this.isSingleTerminalMode(strategy) ? [] : avoidTargets,
          allowFallbackProxy: this.isSingleTerminalMode(strategy) ? false : true,
        }),
      );

      return {
        reviewer: task.recommendedReviewer,
        resolvedBy: result.resolution.resolvedBy,
        proxyUsed: result.resolution.proxyUsed,
        status: result.output.parsed?.decision === 'approve' ? 'approved' : 'needs_changes',
        rounds: round,
        reviewedAt: nowIso(),
        summary: result.output.parsed?.summary || this.copy('未提供复核摘要。', 'No review summary provided.'),
        findings: Array.isArray(result.output.parsed?.findings) ? result.output.parsed?.findings || [] : [],
        openQuestions: safeArray(result.output.parsed?.openQuestions),
        rawOutput: result.output.stdout,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        reviewer: task.recommendedReviewer,
        resolvedBy: task.recommendedReviewer,
        proxyUsed: false,
        status: 'failed',
        rounds: round,
        reviewedAt: nowIso(),
        summary: this.copy(
          `${ENGINE_LABELS[task.recommendedReviewer]} 未能完成任务复核，建议人工补看该任务。`,
          `${ENGINE_LABELS[task.recommendedReviewer]} could not complete the task review. Manual inspection is recommended.`,
        ),
        findings: [
          {
            title: this.copy('任务复核不可用', 'Task review unavailable'),
            severity: 'medium',
            confidence: 0.95,
            details: truncate(message.replace(/\s+/g, ' ').trim(), 600),
            recommendation: this.copy(
              '在进入更大范围测试前，人工检查该任务的变更和验证结果。',
              'Inspect the task changes and verification results manually before broader testing.',
            ),
          },
        ],
        openQuestions: [
          this.copy('是否需要在继续之前人工复核该任务？', 'Should this task be manually reviewed before proceeding?'),
        ],
        rawOutput: message,
      };
    }
  }

  private buildTaskFileContext(files: string[]): string {
    const maxFiles = 6;
    const maxCharsPerFile = 3200;
    const snippets: string[] = [];

    for (const file of unique(files).slice(0, maxFiles)) {
      const absolutePath = path.join(process.cwd(), file);
      if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
        snippets.push(`## ${file}\n(file missing)`);
        continue;
      }

      try {
        const content = fs.readFileSync(absolutePath, 'utf-8');
        if (content.includes('\u0000')) {
          snippets.push(`## ${file}\n(binary or non-text file omitted)`);
          continue;
        }

        snippets.push(`## ${file}\n\`\`\`\n${truncate(content, maxCharsPerFile)}\n\`\`\``);
      } catch (error) {
        snippets.push(`## ${file}\n(unable to read file: ${error instanceof Error ? error.message : String(error)})`);
      }
    }

    return snippets.length > 0 ? snippets.join('\n\n') : '(no relevant file context captured)';
  }

  private deriveTaskStatus(
    exitCode: number,
    changedFiles: string[],
    review?: TaskReviewRecord,
  ): TaskRunRecord['status'] {
    if (exitCode !== 0) {
      return 'failed';
    }
    if (!review) {
      return changedFiles.length === 0 ? 'warning' : 'done';
    }
    if (review.status === 'approved') {
      return changedFiles.length === 0 ? 'warning' : 'done';
    }
    return 'warning';
  }

  private buildTaskOutcomeSummary(
    ownerSummary: string,
    review: TaskReviewRecord | undefined,
    status: TaskRunRecord['status'],
  ): string {
    const ownerPreview = truncate(ownerSummary.replace(/\s+/g, ' ').trim(), 700);
    if (!review) {
      return ownerPreview || this.copy('任务执行完成，但没有捕获到摘要。', 'Task execution finished without a captured summary.');
    }

    const reviewLead =
      review.status === 'approved'
        ? this.copy('复核通过。', 'Review approved.')
        : review.status === 'needs_changes'
          ? this.copy('复核后仍有待修项。', 'Review still requests changes.')
          : this.copy('复核未完成。', 'Review did not complete.');

    return [
      reviewLead,
      ownerPreview,
      truncate(review.summary.replace(/\s+/g, ' ').trim(), status === 'done' ? 220 : 420),
    ]
      .filter(Boolean)
      .join(' ');
  }

  private buildTaskRunMarkdown(task: TaskNode, record: TaskRunRecord): string {
    return [
      `# ${task.id} - ${task.title}`,
      '',
      `- ${this.copy('状态', 'Status')}: ${this.formatTaskStatus(record.status)}`,
      `- ${this.copy('Owner', 'Owner')}: ${ENGINE_LABELS[task.recommendedOwner]}`,
      `- ${this.copy('Reviewer', 'Reviewer')}: ${ENGINE_LABELS[task.recommendedReviewer]}`,
      `- ${this.copy('实际执行', 'Executed By')}: ${ENGINE_LABELS[record.resolvedBy]}${record.proxyUsed ? this.copy('（代理执行）', ' (fallback proxy)') : ''}`,
      '',
      `## ${this.copy('摘要', 'Summary')}`,
      record.summary,
      '',
      `## ${this.copy('变更文件', 'Changed Files')}`,
      ...(record.changedFiles.length > 0 ? record.changedFiles.map(item => `- ${item}`) : [`- ${this.copy('未检测到文件变更。', 'No file changes detected.')}`]),
      '',
      `## ${this.copy('任务输出', 'Task Output')}`,
      record.rawOutput || this.copy('没有捕获到任务输出。', 'No task output captured.'),
      '',
      record.review
        ? [
          `## ${this.copy('复核结论', 'Review Verdict')}`,
          `- ${this.copy('结果', 'Outcome')}: ${this.formatTaskReviewStatus(record.review.status)}`,
          `- ${this.copy('实际复核', 'Reviewed By')}: ${ENGINE_LABELS[record.review.resolvedBy]}${record.review.proxyUsed ? this.copy('（代理执行）', ' (fallback proxy)') : ''}`,
          '',
          record.review.summary,
          '',
        ].join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildTaskReviewMarkdown(task: TaskNode, review: TaskReviewRecord): string {
    return [
      `# ${task.id} ${this.copy('任务复核', 'Task Review')}`,
      '',
      `- ${this.copy('Reviewer', 'Reviewer')}: ${ENGINE_LABELS[task.recommendedReviewer]}`,
      `- ${this.copy('实际复核', 'Reviewed By')}: ${ENGINE_LABELS[review.resolvedBy]}${review.proxyUsed ? this.copy('（代理执行）', ' (fallback proxy)') : ''}`,
      `- ${this.copy('结果', 'Outcome')}: ${this.formatTaskReviewStatus(review.status)}`,
      `- ${this.copy('轮次', 'Round')}: ${review.rounds}`,
      '',
      `## ${this.copy('摘要', 'Summary')}`,
      review.summary,
      '',
      `## ${this.copy('发现', 'Findings')}`,
      ...(review.findings.length > 0
        ? review.findings.flatMap(item => [
          `### ${item.title}`,
          `- ${this.copy('严重级别', 'Severity')}: ${item.severity}`,
          `- ${this.copy('置信度', 'Confidence')}: ${item.confidence}`,
          item.details,
          `${this.copy('建议', 'Recommendation')}: ${item.recommendation}`,
          '',
        ])
        : [`- ${this.copy('无明确问题。', 'No explicit findings.')}`, '']),
      `## ${this.copy('开放问题', 'Open Questions')}`,
      ...(review.openQuestions.length > 0 ? review.openQuestions.map(item => `- ${item}`) : [`- ${this.copy('无', 'None')}`]),
      '',
    ].join('\n');
  }

  private buildFallbackIntegrationReview(
    taskGraph: TaskGraph,
    taskRuns: TaskRunRecord[],
    checks: LocalCheckResult[],
  ): IntegrationReview {
    const completedTasks = taskRuns.filter(run => run.status === 'done').map(run => run.taskId);
    const failedTasks = taskGraph.tasks
      .map(task => task.id)
      .filter(taskId => !completedTasks.includes(taskId) || taskRuns.some(run => run.taskId === taskId && run.status === 'failed'));

    return {
      summary: this.copy(
        `已执行 ${taskRuns.length}/${taskGraph.tasks.length} 个任务，通过 ${checks.filter(check => check.exitCode === 0).length} 个本地检查。`,
        `Executed ${taskRuns.length}/${taskGraph.tasks.length} tasks. ${checks.filter(check => check.exitCode === 0).length} local checks passed.`,
      ),
      completedTasks,
      failedTasks,
      remainingRisks: [
        ...taskRuns.filter(run => run.status !== 'done').map(run => `${run.taskId}: ${run.summary}`),
        ...checks.filter(check => check.exitCode !== 0).map(check => this.copy(`${check.name} 执行失败`, `${check.name} failed`)),
      ],
      suggestedTests: [
        this.copy('在终端里手工跑一遍主流程 happy path。', 'Run the main happy path manually in the terminal.'),
        this.copy('处理任务警告后重新执行 typecheck/build/test。', 'Re-run typecheck/build/test scripts after reviewing task warnings.'),
      ],
      handoffNotes: [
        this.copy('开始更大范围测试前先查看 integration-review.md。', 'Review integration-review.md before broader testing.'),
        this.copy('优先关注带 warning 或 failed 的任务。', 'Focus first on tasks that completed with warning or failed.'),
      ],
    };
  }

  private buildFallbackTaskGraph(repoFiles: string[]): TaskGraph {
    const taskFiles = {
      coreFlow: this.pickExistingFiles(repoFiles, [
        'src/orchestrator.ts',
        'src/types.ts',
        'src/schemas.ts',
      ]),
      adapters: this.pickExistingFiles(repoFiles, [
        'src/adapters/acp-wrapper.ts',
        'src/adapters/base.ts',
        'src/orchestrator.ts',
      ]),
      uxAndArtifacts: this.pickExistingFiles(repoFiles, [
        'src/ui/chat-cli.ts',
        'src/store/index.ts',
        'src/orchestrator.ts',
      ]),
      verification: this.pickExistingFiles(repoFiles, [
        'package.json',
        'tsconfig.json',
        'src/orchestrator.ts',
      ]),
    };

    return this.normalizeTaskGraph([
      {
        id: 'T1',
        title: this.copy('稳住阶段编排与人工决策流', 'Stabilize stage orchestration and human decision flow'),
        description: this.copy(
          '增强审批、圆桌决策、恢复执行和产物生成链路的稳定性，让端到端流程可以更可预测地继续推进。',
          'Make the stage pipeline resilient around approvals, roundtable decisions, resume behavior, and artifact generation so the end-to-end run can continue predictably.',
        ),
        domain: 'architecture',
        dependsOn: [],
        acceptanceCriteria: [
          this.copy('核心阶段切换清晰且可恢复。', 'Core stage transitions are explicit and recoverable.'),
          this.copy('人工评审决策会被持久化，并在后续阶段体现出来。', 'Human review decisions are persisted and reflected in later stages.'),
          this.copy('必须产物能够生成，且不会破坏下游执行。', 'Required stage artifacts are generated without breaking downstream execution.'),
        ],
        recommendedOwner: 'claude',
        recommendedReviewer: 'codex',
        filesToTouch: taskFiles.coreFlow,
        implementationSteps: [
          this.copy('梳理阶段状态、审批节点和恢复路径之间的状态转移。', 'Map the state transitions between stages, approval gates, and resume paths.'),
          this.copy('补强会话状态和关键产物落盘逻辑，避免中途退出后上下文断裂。', 'Harden session-state and artifact persistence so the run can recover after interruptions.'),
          this.copy('校对人工决策结果如何传递到后续阶段，确保最终设计与后续执行读取到同一结论。', 'Verify how manual decisions propagate into later stages so the finalized design and downstream execution read the same outcome.'),
        ],
        verificationSteps: [
          this.copy('走查 Stage 0-4 的状态更新与关键产物文件是否匹配。', 'Inspect Stage 0-4 state updates and confirm they match the expected artifact files.'),
          this.copy('模拟至少一次中断后恢复，确认不会重复生成冲突产物。', 'Simulate at least one interrupted run and confirm resume behavior does not create conflicting artifacts.'),
        ],
        reviewFocus: [
          this.copy('状态切换和恢复语义是否一致。', 'Whether stage transitions and resume semantics are internally consistent.'),
          this.copy('人工决策是否被完整持久化并影响后续行为。', 'Whether manual decisions are fully persisted and influence downstream behavior.'),
        ],
        suggestedCommitMessage: 'feat: stabilize stage orchestration recovery',
      },
      {
        id: 'T2',
        title: this.copy('强化引擎路由、重试与兜底机制', 'Harden engine routing, adapter retries, and fallback behavior'),
        description: this.copy(
          '优化模型选择、代理执行、超时处理和失败恢复，避免某个不可用或不健康的引擎直接中断整条流程。',
          'Improve model selection, proxy execution, timeout handling, and failure recovery so unavailable or unhealthy engines do not terminate the pipeline unexpectedly.',
        ),
        domain: 'backend',
        dependsOn: ['T1'],
        acceptanceCriteria: [
          this.copy('路由失败时能给出可执行的错误提示。', 'Routing failures surface actionable error messages.'),
          this.copy('首选引擎不可用时，重试或代理逻辑会平滑降级。', 'Engine retry or proxy behavior degrades gracefully when a preferred engine is unavailable.'),
          this.copy('阶段级兜底能阻止可避免的致命退出。', 'Stage-level fallbacks prevent avoidable fatal exits.'),
        ],
        recommendedOwner: 'codex',
        recommendedReviewer: 'claude',
        filesToTouch: taskFiles.adapters,
        implementationSteps: [
          this.copy('审视引擎可用性检测、direct execution 和 fallback proxy 的条件分支。', 'Review engine availability detection plus the direct-execution and fallback-proxy branches.'),
          this.copy('针对失败、超时和不健康引擎补强重试或降级逻辑。', 'Strengthen retry or degradation logic around failures, timeouts, and unhealthy engines.'),
          this.copy('让错误信息明确说明哪一个槽位失败、是否发生代理执行以及下一步建议。', 'Make error messages clearly explain which slot failed, whether proxy execution happened, and what to do next.'),
        ],
        verificationSteps: [
          this.copy('确认至少一个引擎缺失时，编排器仍能继续推进到任务规划。', 'Confirm the orchestrator can still reach task planning when at least one engine is missing.'),
          this.copy('类型检查通过，并检查失败分支不会导致未捕获异常。', 'Run type checking and verify failure branches do not surface uncaught exceptions.'),
        ],
        reviewFocus: [
          this.copy('fallback 是否既保留角色语义，又不会在失败时卡死。', 'Whether fallback preserves the intended role semantics without deadlocking on failure.'),
          this.copy('重试条件是否过于激进或过于保守。', 'Whether retry conditions are too aggressive or too conservative.'),
        ],
        suggestedCommitMessage: 'feat: harden engine fallback routing',
      },
      {
        id: 'T3',
        title: this.copy('提升 CLI 引导、会话产物和恢复体验', 'Improve CLI guidance, session artifacts, and resume UX'),
        description: this.copy(
          '让终端状态提示更清晰，并保证保存下来的产物足以支撑人工复核、排障和重跑。',
          'Clarify user-facing status updates in the terminal and ensure saved artifacts make manual review, troubleshooting, and reruns straightforward.',
        ),
        domain: 'integration',
        dependsOn: ['T1'],
        acceptanceCriteria: [
          this.copy('长耗时步骤会显示明显进度或清晰的暂停说明。', 'Long-running steps show visible progress or clear pause instructions.'),
          this.copy('兜底产物或人工复核交接文档包含足够上下文，便于恢复执行。', 'Fallback or manual-review handoff artifacts are saved with enough context to resume.'),
          this.copy('阶段重试后，会话状态仍然容易理解。', 'Session state remains understandable when a stage is retried.'),
        ],
        recommendedOwner: 'claude',
        recommendedReviewer: 'codex',
        filesToTouch: taskFiles.uxAndArtifacts,
        implementationSteps: [
          this.copy('检查关键提示、暂停说明和产物说明文案是否覆盖长耗时与人工介入场景。', 'Inspect key terminal prompts and artifact messaging for long-running or manual-intervention scenarios.'),
          this.copy('补强交接、兜底和任务产物，让用户在恢复执行时知道要看什么。', 'Strengthen handoff, fallback, and task artifacts so the user knows what to inspect when resuming work.'),
          this.copy('确保 task-runs、review packet 和最终 handoff 之间的信息链连贯。', 'Keep the information chain coherent across task-runs, review packets, and the final handoff.'),
        ],
        verificationSteps: [
          this.copy('走读 CLI 提示文案，确认失败、暂停、恢复三类路径都能给出下一步建议。', 'Read through the CLI messaging and confirm failed, paused, and resumed paths all offer a clear next step.'),
          this.copy('验证关键 Markdown 产物会落到预期位置并包含必要摘要。', 'Verify that key Markdown artifacts land in the expected location and contain the required summary.'),
        ],
        reviewFocus: [
          this.copy('用户是否能仅通过终端提示和产物文件理解当前进展。', 'Whether the user can understand progress from terminal output and saved artifacts alone.'),
          this.copy('恢复执行时是否容易定位上一次停在哪里。', 'Whether it is easy to locate where the previous run stopped during resume.'),
        ],
        suggestedCommitMessage: 'feat: improve task artifacts and resume UX',
      },
      {
        id: 'T4',
        title: this.copy('用类型安全和终端回归检查验证流程', 'Verify the workflow with type safety and terminal-level regression checks'),
        description: this.copy(
          '通过收紧任务计划假设并复用现有检查，确认主 CLI 编排路径依旧健康。',
          'Confirm the orchestration path remains healthy by tightening task-plan assumptions and validating the main CLI flow with existing project checks.',
        ),
        domain: 'testing',
        dependsOn: ['T2', 'T3'],
        acceptanceCriteria: [
          this.copy('工作流改动后类型检查通过。', 'Type checking passes after the workflow changes.'),
          this.copy('即使一个或多个引擎失败，流程仍能完成任务规划。', 'The pipeline can complete task planning even when one or more engines fail.'),
          this.copy('关键回归场景会在代码或交接产物里被记录。', 'Key regression scenarios are documented in code or handoff artifacts.'),
        ],
        recommendedOwner: 'codex',
        recommendedReviewer: 'claude',
        filesToTouch: taskFiles.verification,
        implementationSteps: [
          this.copy('梳理当前工作流最容易回归的节点，并把它们体现在代码、检查或交接文档中。', 'Identify the workflow points most likely to regress and reflect them in code, checks, or handoff docs.'),
          this.copy('对任务规划和执行链路加入更明确的假设与防御。', 'Add clearer assumptions and guardrails around the planning and execution chain.'),
          this.copy('确认现有 typecheck/build/test 脚本能够覆盖这轮改动。', 'Confirm the existing typecheck/build/test scripts cover this round of changes.'),
        ],
        verificationSteps: [
          this.copy('运行 `npm run typecheck`。', 'Run `npm run typecheck`.'),
          this.copy('运行 `npm run build`，确认打包链路仍然正常。', 'Run `npm run build` and confirm the bundling path still works.'),
          this.copy('如果仓库提供测试脚本，再补跑一次对应测试。', 'If the repository provides a test script, run it as well.'),
        ],
        reviewFocus: [
          this.copy('回归检查是否真的覆盖了新增流程门禁。', 'Whether the regression checks actually cover the new workflow gates.'),
          this.copy('验证说明是否足够让下一位维护者复现。', 'Whether the verification notes are sufficient for the next maintainer to reproduce.'),
        ],
        suggestedCommitMessage: 'test: verify workflow regression coverage',
      },
    ]);
  }

  private renderDevelopmentStrategyMarkdown(strategy: DevelopmentStrategy): string {
    return [
      `# ${this.copy('开发策略', 'Development Strategy')}`,
      '',
      `- ${this.copy('动作', 'Action')}: ${strategy.actionLabel}`,
      `- ${this.copy('模式', 'Mode')}: ${strategy.modeLabel || this.copy('无', 'N/A')}`,
      `- ${this.copy('单终端固定程序', 'Single Terminal Engine')}: ${strategy.singleTerminalEngineLabel || this.copy('无', 'N/A')}`,
      `- ${this.copy('时间', 'Time')}: ${strategy.decidedAt}`,
      '',
    ].join('\n');
  }

  private describeDevelopmentStrategy(strategy: DevelopmentStrategy): string {
    return [
      `开发动作：${strategy.actionLabel}`,
      strategy.modeLabel ? `开发模式：${strategy.modeLabel}` : undefined,
      strategy.singleTerminalEngineLabel ? `固定程序：${strategy.singleTerminalEngineLabel}` : undefined,
      `策略文件：${this.store.getArtifactPath('development-strategy.md')}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private availableEngineOptionsForSingleTerminal(): { value: string; label: string }[] {
    const preferredOrder = unique([
      this.config.routing.designLead || 'codex',
      ...this.config.routing.fallbackOrder,
      ...ALL_SLOTS,
    ]);

    const options = preferredOrder
      .filter(slot => this.availability[slot]?.available)
      .map(slot => ({ value: slot, label: ENGINE_LABELS[slot] }));

    return options.length > 0 ? options : ALL_SLOTS.map(slot => ({ value: slot, label: ENGINE_LABELS[slot] }));
  }

  private isSingleTerminalMode(strategy: DevelopmentStrategy): boolean {
    return strategy.action === 'start_development' && strategy.mode === 'single_terminal' && Boolean(strategy.singleTerminalEngine);
  }

  private singleTerminalEngineOrThrow(strategy: DevelopmentStrategy): EngineSlot {
    if (!this.isSingleTerminalMode(strategy) || !strategy.singleTerminalEngine) {
      throw new Error('Single-terminal engine is not configured.');
    }
    return strategy.singleTerminalEngine;
  }

  private applyDevelopmentStrategyToTaskGraph(taskGraph: TaskGraph, strategy: DevelopmentStrategy): TaskGraph {
    if (!this.isSingleTerminalMode(strategy)) {
      return taskGraph;
    }

    const engine = this.singleTerminalEngineOrThrow(strategy);
    return {
      tasks: taskGraph.tasks.map(task => ({
        ...task,
        recommendedOwner: engine,
        recommendedReviewer: engine,
      })),
      executionOrder: taskGraph.executionOrder,
    };
  }

  private async runLocalChecks(): Promise<LocalCheckResult[]> {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson = fs.existsSync(packageJsonPath)
      ? (JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as { scripts?: Record<string, string> })
      : null;
    const checks: Array<{ name: string; command: string; args: string[] }> = [];
    const scripts = packageJson?.scripts || {};

    if (scripts.typecheck) {
      checks.push({ name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] });
    } else if (fs.existsSync(path.join(process.cwd(), 'tsconfig.json'))) {
      checks.push({ name: 'tsc-noEmit', command: 'npx', args: ['tsc', '--noEmit'] });
    }

    if (scripts.build) {
      checks.push({ name: 'build', command: 'npm', args: ['run', 'build'] });
    }

    if (scripts.test && !/no test specified/i.test(scripts.test)) {
      checks.push({ name: 'test', command: 'npm', args: ['run', 'test'] });
    }

    const results: LocalCheckResult[] = [];
    for (const check of checks) {
      results.push(await this.runShellCommand(check.name, check.command, check.args));
    }

    return results;
  }

  private runShellCommand(name: string, command: string, args: string[]): Promise<LocalCheckResult> {
    return new Promise(resolve => {
      const child = spawn(command, args, { cwd: process.cwd(), env: process.env });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', chunk => {
        stderr += chunk.toString();
      });

      child.on('error', error => {
        resolve({
          name,
          command: `${command} ${args.join(' ')}`,
          exitCode: 1,
          stdout,
          stderr: error.message,
        });
      });

      child.on('close', exitCode => {
        resolve({
          name,
          command: `${command} ${args.join(' ')}`,
          exitCode: exitCode ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }

  private loadExistingReviews(): StructuredReview[] {
    return ALL_SLOTS.map(slot => this.store.readJson<StructuredReview>(`review-${slot}.json`)).filter(
      (item): item is StructuredReview => Boolean(item),
    );
  }

  private pickExistingFiles(repoFiles: string[], preferred: string[]): string[] {
    const matches = preferred.filter(file => repoFiles.includes(file));
    return matches.length > 0 ? matches : preferred.slice(0, 3);
  }

  private normalizeTaskGraph(tasks: TaskNode[]): TaskGraph {
    const ids = new Set<string>();
    const normalizedTasks: TaskNode[] = tasks.map((task, index) => {
      const id = task.id && !ids.has(task.id) ? task.id : `T${index + 1}`;
      ids.add(id);

      const domain = this.normalizeDomain(task.domain);
      const owner = this.normalizeSlot(task.recommendedOwner) || this.config.routing.domainOwners[domain];
      const reviewer =
        this.normalizeSlot(task.recommendedReviewer) ||
        (owner === 'claude' ? 'codex' : 'claude');

      return {
        id,
        title: task.title || `Task ${index + 1}`,
        description: task.description || task.title || `Implement ${id}`,
        domain,
        dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.filter(dep => dep !== id) : [],
        acceptanceCriteria: safeArray(task.acceptanceCriteria),
        recommendedOwner: owner,
        recommendedReviewer: reviewer,
        filesToTouch: safeArray(task.filesToTouch),
        implementationSteps: this.normalizeImplementationSteps(task),
        verificationSteps: this.normalizeVerificationSteps(task),
        reviewFocus: this.normalizeReviewFocus(task),
        suggestedCommitMessage: this.normalizeCommitMessage(task),
      };
    });

    const knownIds = new Set(normalizedTasks.map(task => task.id));
    for (const task of normalizedTasks) {
      task.dependsOn = task.dependsOn.filter(dep => knownIds.has(dep));
    }

    return {
      tasks: normalizedTasks,
      executionOrder: this.topologicalSort(normalizedTasks),
    };
  }

  private normalizeImplementationSteps(task: TaskNode): string[] {
    const steps = safeArray(task.implementationSteps);
    if (steps.length > 0) {
      return steps;
    }

    const fileTargets =
      task.filesToTouch.length > 0
        ? task.filesToTouch.join(', ')
        : this.copy('相关实现文件', 'the relevant implementation files');

    return [
      this.copy(`先阅读并确认将修改的文件边界：${fileTargets}。`, `Review and confirm the edit boundary in ${fileTargets}.`),
      this.copy(`按任务范围实现最小必要改动，完成“${task.title}”。`, `Implement the smallest set of changes needed to complete "${task.title}".`),
      this.copy('同步补齐必要的类型、配置、文档或调用链调整，避免留下明显断点。', 'Update any adjacent types, config, docs, or call sites needed to keep the workflow coherent.'),
    ];
  }

  private normalizeVerificationSteps(task: TaskNode): string[] {
    const steps = safeArray(task.verificationSteps);
    if (steps.length > 0) {
      return steps;
    }

    return [
      this.copy('运行与本任务最相关的局部检查或命令，确认主路径可用。', 'Run the most relevant focused check or command for this task and confirm the main path works.'),
      this.copy('重新执行项目级 typecheck / build / test（若仓库支持），确认没有引入回归。', 'Re-run project-level typecheck / build / test where available to confirm no regressions were introduced.'),
      this.copy(
        task.acceptanceCriteria.length > 0
          ? `逐条对照验收标准，至少确认以下内容：${task.acceptanceCriteria.slice(0, 2).join('；')}`
          : '逐条回看任务描述，确认核心验收路径已经覆盖。',
        task.acceptanceCriteria.length > 0
          ? `Check the acceptance criteria one by one, especially: ${task.acceptanceCriteria.slice(0, 2).join('; ')}`
          : 'Re-check the task description and confirm the core acceptance path is covered.',
      ),
    ];
  }

  private normalizeReviewFocus(task: TaskNode): string[] {
    const focus = safeArray(task.reviewFocus);
    if (focus.length > 0) {
      return focus;
    }

    return [
      this.copy('验收标准是否真的在代码和行为上落地。', 'Whether the acceptance criteria are actually reflected in the code and behavior.'),
      this.copy('变更是否保持在任务边界内，没有顺手扩大范围。', 'Whether the changes stay within task scope instead of drifting into adjacent work.'),
      this.copy('测试、错误处理和可维护性是否至少达到当前仓库的合理水位。', 'Whether testing, error handling, and maintainability stay at a reasonable level for this repository.'),
    ];
  }

  private normalizeCommitMessage(task: TaskNode): string {
    const candidate = String(task.suggestedCommitMessage || '').trim().replace(/\s+/g, ' ');
    if (candidate) {
      return candidate;
    }

    const prefix =
      task.domain === 'docs' ? 'docs' : task.domain === 'testing' ? 'test' : task.domain === 'ops' ? 'chore' : 'feat';
    const subject = (task.title || task.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 7)
      .join(' ');

    return `${prefix}: ${subject || `complete ${task.id.toLowerCase()}`}`;
  }

  private topologicalSort(tasks: TaskNode[]): string[] {
    const pending = new Map(tasks.map(task => [task.id, new Set(task.dependsOn)]));
    const resolved: string[] = [];

    while (pending.size > 0) {
      const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
      if (ready.length === 0) {
        return tasks.map(task => task.id);
      }

      for (const id of ready) {
        resolved.push(id);
        pending.delete(id);
        for (const deps of pending.values()) {
          deps.delete(id);
        }
      }
    }

    return resolved;
  }

  private normalizeDomain(domain: string): TaskDomain {
    const value = String(domain || '').toLowerCase();
    if (['frontend', 'backend', 'architecture', 'integration', 'testing', 'data', 'docs', 'ops'].includes(value)) {
      return value as TaskDomain;
    }
    return 'backend';
  }

  private normalizeSlot(slot: string | undefined): EngineSlot | undefined {
    if (slot === 'claude' || slot === 'codex' || slot === 'gemini') {
      return slot;
    }
    return undefined;
  }

  private formatExecutionSummary(roleLabel: string, slot: EngineSlot, resolution: SlotResolution): string {
    return this.formatRoutedExecution(roleLabel, resolution, ENGINE_STAGE_HINTS[slot], ENGINE_LABELS[slot]);
  }

  private announceTechDesignProgress(
    leadSlot: EngineSlot,
    status: 'running' | 'completed',
    resolution?: SlotResolution,
    durationMs?: number,
  ): void {
    const lines = [
      `技术设计主写：${ENGINE_LABELS[leadSlot]}`,
      `当前状态：${status === 'running' ? '进行中' : '已完成'}`,
      `当前动作：${status === 'running'
        ? `${ENGINE_LABELS[leadSlot]} 正在主写技术设计草稿。`
        : `${ENGINE_LABELS[leadSlot]} 已完成技术设计草稿，可进入交叉 Review。`}`,
      `主写关注点：${ENGINE_STAGE_HINTS[leadSlot]}`,
      resolution
        ? resolution.proxyUsed
          ? `实际执行：${resolution.resolvedLabel}（代理 ${ENGINE_LABELS[leadSlot]} 主写角色）`
          : `实际执行：${resolution.resolvedLabel}`
        : undefined,
      durationMs ? `耗时：${this.formatDurationMs(durationMs)}` : undefined,
      status === 'running'
        ? this.copy(
          '可见性：长文阶段只显示状态与心跳，避免把正文重复打印到终端里。',
          'Visibility: long-form stages show status and heartbeats only to avoid printing the full document twice.',
        )
        : undefined,
    ].filter((line): line is string => Boolean(line));

    ChatUI.info('Stage 2 Progress', lines.join('\n'));
    if (status === 'running') {
      this.store.markStage('stage2-tech-design', 'running', `${ENGINE_LABELS[leadSlot]} drafting the technical design`);
    }
  }

  private announceReviewProgress(
    leadSlot: EngineSlot,
    leadResolution: SlotResolution,
    reviewSlots: EngineSlot[],
    reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>>,
    currentAction: string,
  ): void {
    const finishedCount = reviewSlots.filter(slot => {
      const state = reviewProgress[slot];
      return state?.status === 'completed' || state?.status === 'fallback' || state?.status === 'skipped';
    }).length;

    const lines = [
      `被 Review 的稿件：${ENGINE_LABELS[leadSlot]} 主写的技术设计草稿${leadResolution.proxyUsed ? `（实际由 ${leadResolution.resolvedLabel} 代理执行）` : ''}`,
      `当前进度：${finishedCount}/${reviewSlots.length} 个 Reviewer 已结束`,
      `当前动作：${currentAction}`,
      '执行方式：当前版本按 Reviewer 串行执行，未开始的 Reviewer 会明确显示为等待中。',
      ...(ChatUI.canUseInteractiveTaskSession()
        ? [this.copy('快捷操作：等待当前 Reviewer 时可按 s 跳过当前 review。', 'Shortcut: press s while waiting to skip the current review.')]
        : []),
      '',
      ...reviewSlots.map(
        (slot, index) =>
          `- Review ${index + 1}：${ENGINE_LABELS[slot]} | ${ENGINE_STAGE_HINTS[slot]} | ${this.formatReviewProgressStatus(reviewProgress[slot])}`,
      ),
    ];

    ChatUI.info('Stage 3 Progress', lines.join('\n'));
    this.store.markStage(
      'stage3-reviews',
      'running',
      `${finishedCount}/${reviewSlots.length} reviewers finished. ${currentAction}`,
    );
  }

  private announcePrdReviewProgress(
    targetFilePath: string,
    reviewSlots: EngineSlot[],
    reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>>,
    currentAction: string,
  ): void {
    const finishedCount = reviewSlots.filter(slot => {
      const state = reviewProgress[slot];
      return state?.status === 'completed' || state?.status === 'fallback' || state?.status === 'skipped';
    }).length;

    const lines = [
      `评审对象：${path.basename(targetFilePath)}`,
      `当前进度：${finishedCount}/${reviewSlots.length} 个 Reviewer 已结束`,
      `当前动作：${currentAction}`,
      '执行方式：当前版本会并行启动全部 Reviewer，再统一汇总结果。',
      '',
      ...reviewSlots.map(
        (slot, index) =>
          `- Review ${index + 1}：${ENGINE_LABELS[slot]} | ${this.describePrdReviewLens(slot)} | ${this.formatReviewProgressStatus(reviewProgress[slot])}`,
      ),
    ];

    ChatUI.info('PRD Review Progress', lines.join('\n'));
    this.store.markStage(
      'command-reviewprd',
      'running',
      `${finishedCount}/${reviewSlots.length} PRD reviewers finished. ${currentAction}`,
    );
  }

  private announceDesignReviewProgress(
    targetFilePath: string,
    reviewSlots: EngineSlot[],
    reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>>,
    currentAction: string,
  ): void {
    const finishedCount = reviewSlots.filter(slot => {
      const state = reviewProgress[slot];
      return state?.status === 'completed' || state?.status === 'fallback' || state?.status === 'skipped';
    }).length;

    const lines = [
      `评审对象：${path.basename(targetFilePath)}`,
      `当前进度：${finishedCount}/${reviewSlots.length} 个 Reviewer 已结束`,
      `当前动作：${currentAction}`,
      '执行方式：当前版本会并行启动全部 Reviewer，再统一汇总结果。',
      '',
      ...reviewSlots.map(
        (slot, index) =>
          `- Review ${index + 1}：${ENGINE_LABELS[slot]} | ${this.describeDesignReviewLens(slot)} | ${this.formatReviewProgressStatus(reviewProgress[slot])}`,
      ),
    ];

    ChatUI.info('Design Review Progress', lines.join('\n'));
    this.store.markStage(
      'command-reviewd',
      'running',
      `${finishedCount}/${reviewSlots.length} design reviewers finished. ${currentAction}`,
    );
  }

  private describeNextReviewAction(
    leadSlot: EngineSlot,
    reviewSlots: EngineSlot[],
    reviewProgress: Partial<Record<EngineSlot, ReviewProgressState>>,
  ): string {
    const nextSlot = reviewSlots.find(slot => reviewProgress[slot]?.status === 'queued');
    if (nextSlot) {
      return this.copy(
        `下一步会由 ${ENGINE_LABELS[nextSlot]} 接着 review ${ENGINE_LABELS[leadSlot]} 写的技术设计草稿。`,
        `${ENGINE_LABELS[nextSlot]} will review the design drafted by ${ENGINE_LABELS[leadSlot]} next.`,
      );
    }

    return this.copy(
      '全部独立 Review 已结束，正在汇总结论。',
      'All independent reviews are complete. Summarizing the consensus now.',
    );
  }

  private formatRoutedExecution(
    roleLabel: string,
    resolution: SlotResolution,
    focus?: string,
    intendedLabel?: string,
  ): string {
    const roleOwner = intendedLabel || resolution.slotLabel;
    return [
      `${roleLabel}：${roleOwner}`,
      focus ? `关注点：${focus}` : undefined,
      resolution.proxyUsed
        ? `实际执行：${resolution.resolvedLabel}（代理 ${roleOwner} 角色）`
        : `实际执行：${resolution.resolvedLabel}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private formatSlotPreference(label: string, slots: EngineSlot[]): string {
    return `${label}：${unique(slots).map(slot => ENGINE_LABELS[slot]).join(' -> ')}`;
  }

  private formatReviewProgressStatus(state?: ReviewProgressState): string {
    if (!state || state.status === 'queued') {
      return this.copy('等待开始', 'Queued');
    }

    if (state.status === 'running') {
      return this.copy(
        `进行中${state.detail ? `：${state.detail}` : ''}`,
        `Running${state.detail ? `: ${state.detail}` : ''}`,
      );
    }

    if (state.status === 'completed') {
      const executorNote =
        state.resolution && state.resolution.proxyUsed
          ? this.copy(`，实际执行：${state.resolution.resolvedLabel}`, `, executed by ${state.resolution.resolvedLabel}`)
          : '';
      return this.copy(
        `已完成${state.durationMs ? `（${this.formatDurationMs(state.durationMs)}）` : ''}${executorNote}`,
        `Completed${state.durationMs ? ` (${this.formatDurationMs(state.durationMs)})` : ''}${executorNote}`,
      );
    }

    if (state.status === 'skipped') {
      return this.copy(
        `已手动跳过${state.detail ? `：${state.detail}` : ''}`,
        `Skipped manually${state.detail ? `: ${state.detail}` : ''}`,
      );
    }

    return this.copy(
      `已写入 fallback review${state.detail ? `：${state.detail}` : ''}`,
      `Fallback saved${state.detail ? `: ${state.detail}` : ''}`,
    );
  }

  private summarizeTaskAssignments(taskGraph: TaskGraph): string {
    const ownerCounts = this.countSlotAssignments(taskGraph.tasks.map(task => task.recommendedOwner));
    const reviewerCounts = this.countSlotAssignments(taskGraph.tasks.map(task => task.recommendedReviewer));

    return [
      `任务总数：${taskGraph.tasks.length}`,
      `执行顺序：${taskGraph.executionOrder.join(' -> ')}`,
      `Owner 分配：${ownerCounts}`,
      `Reviewer 分配：${reviewerCounts}`,
    ].join('\n');
  }

  private countSlotAssignments(slots: EngineSlot[]): string {
    return ALL_SLOTS.map(slot => `${ENGINE_LABELS[slot]} ${slots.filter(item => item === slot).length}`).join(' / ');
  }

  private formatTaskRunSummary(task: TaskNode, record: TaskRunRecord): string {
    return [
      `任务：${task.id} - ${task.title}`,
      `Owner：${ENGINE_LABELS[task.recommendedOwner]}`,
      `Reviewer：${ENGINE_LABELS[task.recommendedReviewer]}`,
      record.proxyUsed
        ? `实际执行：${ENGINE_LABELS[record.resolvedBy]}（代理 ${ENGINE_LABELS[task.recommendedOwner]} Owner 角色）`
        : `实际执行：${ENGINE_LABELS[record.resolvedBy]}`,
      `结果：${this.formatTaskStatus(record.status)}`,
      record.review ? `复核：${this.formatTaskReviewStatus(record.review.status)}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private formatTaskReviewSummary(task: TaskNode, review: TaskReviewRecord): string {
    return [
      `任务：${task.id} - ${task.title}`,
      `Reviewer：${ENGINE_LABELS[task.recommendedReviewer]}`,
      review.proxyUsed
        ? `实际复核：${ENGINE_LABELS[review.resolvedBy]}（代理 ${ENGINE_LABELS[task.recommendedReviewer]} Reviewer 角色）`
        : `实际复核：${ENGINE_LABELS[review.resolvedBy]}`,
      `结论：${this.formatTaskReviewStatus(review.status)}`,
      review.findings.length > 0 ? `发现数：${review.findings.length}` : undefined,
      review.summary,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private formatTaskStatus(status: TaskRunRecord['status']): string {
    if (status === 'done') {
      return '已完成';
    }
    if (status === 'warning') {
      return '完成但有警告';
    }
    if (status === 'skipped') {
      return '已跳过';
    }
    return '失败';
  }

  private formatTaskReviewStatus(status: TaskReviewRecord['status']): string {
    if (status === 'approved') {
      return this.copy('通过', 'Approved');
    }
    if (status === 'needs_changes') {
      return this.copy('需修改', 'Needs changes');
    }
    return this.copy('复核失败', 'Review failed');
  }

  private formatRoundtableSpeakerLabel(turn: RoundtableTurn): string {
    return turn.proxyUsed ? `${turn.agentLabel} via ${ENGINE_LABELS[turn.resolvedBy]}` : turn.agentLabel;
  }

  private summarizeLocalChecks(checks: LocalCheckResult[]): string {
    if (checks.length === 0) {
      return '未发现可执行的 typecheck / build / test 脚本，跳过本地检查。';
    }

    return checks
      .map(check => `${check.name}：${check.exitCode === 0 ? '通过' : '失败'} (${check.command})`)
      .join('\n');
  }

  private shouldUseInteractiveTaskSession(slot: EngineSlot): boolean {
    return ChatUI.canUseInteractiveTaskSession() && this.interactiveAvailability[slot]?.available === true;
  }

  private maybeAnnounceInteractiveTaskDowngrade(slot: EngineSlot): void {
    if (!ChatUI.canUseInteractiveTaskSession()) {
      return;
    }

    const status = this.interactiveAvailability[slot];
    if (status?.available || this.interactiveDowngradeNotified.has(slot)) {
      return;
    }

    this.interactiveDowngradeNotified.add(slot);
    ChatUI.info(
      'Task Execution Mode',
      this.copy(
        `${ENGINE_LABELS[slot]} 当前无法启动实时终端会话，已自动降级为非交互执行。\n原因：${status?.reason || 'interactive PTY unavailable.'}`,
        `${ENGINE_LABELS[slot]} cannot start a live task session in the current terminal, so execution was automatically downgraded to headless mode.\nReason: ${status?.reason || 'interactive PTY unavailable.'}`,
      ),
    );
  }

  private describeTaskExecutionSessionMode(strategy: DevelopmentStrategy): string {
    if (!ChatUI.canUseInteractiveTaskSession()) {
      return this.copy('实时会话：当前终端不是交互 TTY，将直接使用非交互执行。', 'Live session: the current terminal is not interactive, so execution will run headlessly.');
    }

    if (!this.isSingleTerminalMode(strategy)) {
      return this.copy('实时会话：若当前 Owner 的 PTY 健康检查失败，会自动降级为非交互执行。', 'Live session: if the current owner fails the PTY health check, execution will auto-downgrade to headless mode.');
    }

    const slot = this.singleTerminalEngineOrThrow(strategy);
    const status = this.interactiveAvailability[slot];
    if (status?.available) {
      return this.copy(`实时会话：${ENGINE_LABELS[slot]} 已通过 PTY 健康检查，可按需进入实时终端会话。`, `Live session: ${ENGINE_LABELS[slot]} passed the PTY health check and can use a live terminal session when needed.`);
    }

    return this.copy(
      `实时会话：${ENGINE_LABELS[slot]} 未通过 PTY 健康检查，将自动降级为非交互执行。`,
      `Live session: ${ENGINE_LABELS[slot]} did not pass the PTY health check and will auto-downgrade to headless mode.`,
    );
  }

  private formatRequirementComplexity(complexity: RequirementAssessment['complexity']): string {
    if (complexity === 'high') {
      return this.copy('高', 'High');
    }
    if (complexity === 'medium') {
      return this.copy('中', 'Medium');
    }
    return this.copy('低', 'Low');
  }

  private formatRequirementClarity(clarity: RequirementAssessment['clarity']): string {
    if (clarity === 'clear') {
      return this.copy('清晰', 'Clear');
    }
    if (clarity === 'needs_clarification') {
      return this.copy('需进一步澄清', 'Needs clarification');
    }
    return this.copy('需确认', 'Needs confirmation');
  }

  private formatRequirementNextStep(nextStep: RequirementAssessment['nextStep']): string {
    if (nextStep === 'confirm_summary_and_validate') {
      return this.copy('先做需求总结确认，再拉其他 Agent 校验', 'Confirm a short summary, then validate with other agents');
    }
    if (nextStep === 'confirm_summary') {
      return this.copy('先做需求总结确认', 'Confirm a short requirement summary first');
    }
    return this.copy('直接写 PRD', 'Write the PRD directly');
  }

  private summarizePrdReviews(reviews: StructuredReview[]): ConsensusSummary {
    const consensusPoints: string[] = [];
    const unresolvedQuestions = reviews.flatMap(review => review.openQuestions).filter(Boolean);
    const weightedFindings = reviews.flatMap(review =>
      review.findings.map(finding => ({
        reviewer: review.reviewerLabel,
        title: finding.title,
        severity: finding.severity,
        details: finding.details,
      })),
    );

    if (reviews.every(review => review.verdict === 'Approve')) {
      consensusPoints.push(
        this.copy(
          '所有 Reviewer 都认为这份 PRD 已达到可继续推进到技术设计或实现拆解的质量线。',
          'All reviewers agree this PRD is strong enough to move into technical design or implementation planning.',
        ),
      );
    }

    const conflicts =
      reviews.some(review => review.verdict !== 'Approve') || weightedFindings.length > 0
        ? [
          {
            id: 'prd-readiness',
            question: this.copy(
              '这份 PRD 是否已经足够清晰，可以直接进入下一阶段？',
              'Is this PRD clear enough to move directly into the next stage?',
            ),
            whyItMatters: this.copy(
              '这会决定我们是继续推进技术设计 / 开发，还是先补齐目标、范围和验收标准。',
              'This determines whether work should continue into design/development or pause for clarifications on goals, scope, and acceptance criteria.',
            ),
            options: [
              {
                value: 'proceed',
                label: this.copy('按当前 PRD 继续推进', 'Proceed with the current PRD'),
                rationale: this.copy(
                  '现有问题风险可控，或可以在后续设计阶段继续收敛。',
                  'The current issues are manageable or can be tightened during the next design stage.',
                ),
              },
              {
                value: 'revise',
                label: this.copy('先修订 PRD 再推进', 'Revise the PRD before proceeding'),
                rationale: this.copy(
                  '仍有关键不清晰项，继续推进会把问题带到后续设计或实现里。',
                  'Critical ambiguities remain, and pushing forward would carry them into design or implementation.',
                ),
              },
            ],
          },
        ]
        : [];

    const severityWeight = (level: 'low' | 'medium' | 'high') => {
      if (level === 'high') {
        return 3;
      }
      if (level === 'medium') {
        return 2;
      }
      return 1;
    };

    const topFindings = weightedFindings
      .sort((left, right) => severityWeight(right.severity) - severityWeight(left.severity))
      .slice(0, 5)
      .map(item => `${item.reviewer}: ${item.title} - ${item.details}`);

    return {
      summary:
        topFindings.length > 0
          ? `${this.copy('重点 PRD 关注点', 'Top PRD concerns')}:\n- ${topFindings.join('\n- ')}`
          : this.copy('当前评审集合中未发现阻塞 PRD 推进的重大问题。', 'No major blockers were found in the current PRD review set.'),
      consensusPoints,
      conflicts,
      unresolvedQuestions,
    };
  }

  private async generateRevisedPrdFromReviews(
    command: ReviewPrdSlashCommand,
    prdContent: string,
    consensus: ConsensusSummary,
    reviews: StructuredReview[],
  ): Promise<string> {
    const prompt = [
      'You are a senior product manager revising an existing PRD based on review feedback.',
      'Rewrite the PRD in markdown.',
      'Return a complete revised PRD only. Do not include commentary, review notes, or code fences.',
      'Important constraints:',
      '- Do not ask for permissions.',
      '- Do not mention permissions, write access, sandboxing, or tool limitations.',
      '- Do not attempt to edit or update any file yourself.',
      '- The caller will save your exact stdout into the destination markdown file.',
      'Goals:',
      '- Preserve the original intent where it is valid.',
      '- Fix ambiguity, contradictions, unrealistic scope, and weak acceptance criteria based on the review feedback.',
      '- Keep assumptions explicit instead of inventing unsupported commitments.',
      '- Tighten goals, scope, non-goals, scenarios, requirements, risks, milestones, and acceptance criteria where needed.',
      '- If a reviewer requested clarification that still cannot be resolved from the source PRD, capture it as an assumption, scope note, risk, or explicit open question inside the revised PRD.',
      '',
      `Original PRD:\n${prdContent}`,
      '',
      `Consensus JSON:\n${JSON.stringify(consensus, null, 2)}`,
      '',
      `Reviewer outputs JSON:\n${JSON.stringify(reviews, null, 2)}`,
    ].join('\n');

    try {
      const result = await this.runWithLoading(
        {
          start: this.copy('正在基于评审结果生成修订版 PRD...', 'Generating a revised PRD from the review findings...'),
          success: this.copy('修订版 PRD 已生成', 'Revised PRD generated'),
          failure: this.copy('修订版 PRD 生成失败，将改用本地兜底版本', 'Revised PRD generation failed; falling back to a local draft'),
        },
        () => this.runTextWithPreferredSlots(this.buildSlotPreference('claude', 'prd'), prompt),
        {
          heartbeatMs: 30_000,
          onHeartbeat: elapsedMs => this.copy(
            `修订版 PRD 仍在生成中，已等待 ${this.formatDurationMs(elapsedMs)}。`,
            `The revised PRD is still being generated (${this.formatDurationMs(elapsedMs)} elapsed).`,
          ),
        },
      );

      ChatUI.info('PRD Revision Routing', this.formatExecutionSummary('PRD 修订主写', 'claude', result.resolution));
      return this.ensureGeneratedDocumentOutput(
        normalizeMarkdownDocument(result.output.stdout),
        this.copy('修订版 PRD', 'revised PRD'),
      );
    } catch (error) {
      this.reportModelFallback(
        'PRD Revision Routing',
        this.copy('修订版 PRD：模型执行失败，已切换为本地兜底修订稿。', 'Revised PRD: model execution failed; switching to a local fallback draft.'),
        error,
      );
      return this.buildFallbackRevisedPrd(prdContent, consensus, reviews);
    }
  }

  private async generatePrdReviewReport(
    command: ReviewPrdSlashCommand,
    prdContent: string,
    consensus: ConsensusSummary,
    reviews: StructuredReview[],
    revisedPrdPath: string,
  ): Promise<string> {
    const prompt = [
      'You are the final PRD review reporter for AegisFlow.',
      'Write a user-facing PRD review report in markdown.',
      'Use the reviewer outputs and consensus data to synthesize a concise, high-signal report.',
      'Do not mechanically dump every finding. Merge overlapping points and prioritize the most important issues.',
      'Return raw markdown only. Do not wrap the answer in triple backticks.',
      'Important constraints:',
      '- Do not ask for permissions.',
      '- Do not mention permissions, write access, sandboxing, or tool limitations.',
      '- Do not attempt to edit any file yourself.',
      '- The caller will save your exact stdout into the destination markdown file.',
      'Suggested sections:',
      '- Overall Verdict',
      '- Executive Summary',
      '- Key Findings',
      '- Open Questions',
      '- Recommended Next Step',
      '- Reviewer Breakdown',
      '- Revised PRD Output',
      '',
      `Original PRD:\n${prdContent}`,
      '',
      `Consensus JSON:\n${JSON.stringify(consensus, null, 2)}`,
      '',
      `Reviewer outputs JSON:\n${JSON.stringify(reviews, null, 2)}`,
    ].join('\n');

    try {
      const result = await this.runWithLoading(
        {
          start: this.copy('正在生成最终 PRD review 报告...', 'Generating the final PRD review report...'),
          success: this.copy('PRD review 报告已生成', 'The PRD review report has been generated'),
          failure: this.copy('PRD review 报告生成失败，将改用本地兜底报告', 'PRD review report generation failed; falling back to a local report'),
        },
        () => this.runTextWithPreferredSlots(this.buildSlotPreference('codex', 'prd'), prompt),
        {
          heartbeatMs: 30_000,
          onHeartbeat: elapsedMs => this.copy(
            `最终 PRD review 报告仍在生成中，已等待 ${this.formatDurationMs(elapsedMs)}。`,
            `The final PRD review report is still being generated (${this.formatDurationMs(elapsedMs)} elapsed).`,
          ),
        },
      );

      ChatUI.info('PRD Report Routing', this.formatExecutionSummary('PRD Review 报告主写', 'codex', result.resolution));
      return this.ensureGeneratedDocumentOutput(
        normalizeMarkdownDocument(result.output.stdout),
        this.copy('PRD review 报告', 'PRD review report'),
      );
    } catch (error) {
      this.reportModelFallback(
        'PRD Report Routing',
        this.copy('PRD review 报告：模型执行失败，已切换为本地兜底报告。', 'PRD review report: model execution failed; switching to a local fallback report.'),
        error,
      );
      return this.renderPrdReviewConsensusMarkdown(consensus, reviews, command.targetFilePath, revisedPrdPath);
    }
  }

  private async generateRevisedDesignFromReviews(
    command: ReviewDesignSlashCommand,
    designContent: string,
    consensus: ConsensusSummary,
    reviews: StructuredReview[],
  ): Promise<string> {
    const prompt = [
      'You are a principal engineer revising an existing technical design based on review feedback.',
      'Rewrite the technical design in markdown.',
      'Return a complete revised technical design only. Do not include commentary, review notes, or code fences.',
      'Important constraints:',
      '- Do not ask for permissions.',
      '- Do not mention permissions, write access, sandboxing, or tool limitations.',
      '- Do not attempt to edit or update any file yourself.',
      '- The caller will save your exact stdout into the destination markdown file.',
      'Goals:',
      '- Preserve the original intent where it is valid.',
      '- Fix ambiguity, contradictory decisions, weak module boundaries, missing interface definitions, insufficient operational detail, and weak testing strategy based on the review feedback.',
      '- Keep assumptions explicit instead of inventing unsupported commitments.',
      '- Tighten architecture, modules, data flow, failure handling, observability, rollout, risks, and validation strategy where needed.',
      '- If a reviewer requested clarification that still cannot be resolved from the source design, capture it as an assumption, scope note, risk, or explicit open question inside the revised design.',
      '',
      `Original technical design:\n${designContent}`,
      '',
      `Consensus JSON:\n${JSON.stringify(consensus, null, 2)}`,
      '',
      `Reviewer outputs JSON:\n${JSON.stringify(reviews, null, 2)}`,
    ].join('\n');

    try {
      const result = await this.runWithLoading(
        {
          start: this.copy('正在基于评审结果生成修订版技术设计...', 'Generating a revised technical design from the review findings...'),
          success: this.copy('修订版技术设计已生成', 'Revised technical design generated'),
          failure: this.copy('修订版技术设计生成失败，将改用本地兜底版本', 'Revised technical design generation failed; falling back to a local draft'),
        },
        () => this.runTextWithPreferredSlots(this.buildSlotPreference('claude', 'finalDesign'), prompt),
        {
          heartbeatMs: 30_000,
          onHeartbeat: elapsedMs => this.copy(
            `修订版技术设计仍在生成中，已等待 ${this.formatDurationMs(elapsedMs)}。`,
            `The revised technical design is still being generated (${this.formatDurationMs(elapsedMs)} elapsed).`,
          ),
        },
      );

      ChatUI.info('Design Revision Routing', this.formatExecutionSummary('Design 修订主写', 'claude', result.resolution));
      return this.ensureGeneratedDocumentOutput(
        normalizeMarkdownDocument(result.output.stdout),
        this.copy('修订版技术设计', 'revised technical design'),
      );
    } catch (error) {
      this.reportModelFallback(
        'Design Revision Routing',
        this.copy('修订版技术设计：模型执行失败，已切换为本地兜底修订稿。', 'Revised technical design: model execution failed; switching to a local fallback draft.'),
        error,
      );
      return this.buildFallbackRevisedDesign(designContent, consensus, reviews);
    }
  }

  private async generateDesignReviewReport(
    command: ReviewDesignSlashCommand,
    designContent: string,
    consensus: ConsensusSummary,
    reviews: StructuredReview[],
    revisedDesignPath: string,
  ): Promise<string> {
    const prompt = [
      'You are the final technical design review reporter for AegisFlow.',
      'Write a user-facing technical design review report in markdown.',
      'Use the reviewer outputs and consensus data to synthesize a concise, high-signal report.',
      'Do not mechanically dump every finding. Merge overlapping points and prioritize the most important issues.',
      'Return raw markdown only. Do not wrap the answer in triple backticks.',
      'Important constraints:',
      '- Do not ask for permissions.',
      '- Do not mention permissions, write access, sandboxing, or tool limitations.',
      '- Do not attempt to edit any file yourself.',
      '- The caller will save your exact stdout into the destination markdown file.',
      'Suggested sections:',
      '- Overall Verdict',
      '- Executive Summary',
      '- Key Findings',
      '- Open Questions',
      '- Recommended Next Step',
      '- Reviewer Breakdown',
      '- Revised Design Output',
      '',
      `Original technical design:\n${designContent}`,
      '',
      `Consensus JSON:\n${JSON.stringify(consensus, null, 2)}`,
      '',
      `Reviewer outputs JSON:\n${JSON.stringify(reviews, null, 2)}`,
    ].join('\n');

    try {
      const result = await this.runWithLoading(
        {
          start: this.copy('正在生成最终技术设计 review 报告...', 'Generating the final technical design review report...'),
          success: this.copy('技术设计 review 报告已生成', 'The technical design review report has been generated'),
          failure: this.copy('技术设计 review 报告生成失败，将改用本地兜底报告', 'Technical design review report generation failed; falling back to a local report'),
        },
        () => this.runTextWithPreferredSlots(this.buildSlotPreference('codex', 'techDesign'), prompt),
        {
          heartbeatMs: 30_000,
          onHeartbeat: elapsedMs => this.copy(
            `最终技术设计 review 报告仍在生成中，已等待 ${this.formatDurationMs(elapsedMs)}。`,
            `The final technical design review report is still being generated (${this.formatDurationMs(elapsedMs)} elapsed).`,
          ),
        },
      );

      ChatUI.info('Design Report Routing', this.formatExecutionSummary('Design Review 报告主写', 'codex', result.resolution));
      return this.ensureGeneratedDocumentOutput(
        normalizeMarkdownDocument(result.output.stdout),
        this.copy('技术设计 review 报告', 'technical design review report'),
      );
    } catch (error) {
      this.reportModelFallback(
        'Design Report Routing',
        this.copy('技术设计 review 报告：模型执行失败，已切换为本地兜底报告。', 'Technical design review report: model execution failed; switching to a local fallback report.'),
        error,
      );
      return this.renderDesignReviewConsensusMarkdown(consensus, reviews, command.targetFilePath, revisedDesignPath);
    }
  }

  private buildFallbackRevisedPrd(
    prdContent: string,
    consensus: ConsensusSummary,
    reviews: StructuredReview[],
  ): string {
    const topFindings = reviews
      .flatMap(review => review.findings.map(finding => `${review.reviewerLabel}: ${finding.title} - ${finding.recommendation}`))
      .slice(0, 8);

    return [
      prdContent.trim(),
      '',
      `## ${this.copy('修订说明', 'Revision Notes')}`,
      ...this.renderMarkdownList(
        topFindings.length > 0
          ? topFindings
          : [this.copy('本次自动修订未拿到更多结构化问题，建议人工对照 review 报告继续收敛。', 'No additional structured issues were available for the automatic revision. Review the report manually and continue refining.')],
        this.copy('无', 'None'),
      ),
      '',
      `## ${this.copy('剩余待确认问题', 'Remaining Open Questions')}`,
      ...this.renderMarkdownList(consensus.unresolvedQuestions, this.copy('无', 'None')),
      '',
    ].join('\n');
  }

  private buildFallbackRevisedDesign(
    designContent: string,
    consensus: ConsensusSummary,
    reviews: StructuredReview[],
  ): string {
    const topFindings = reviews
      .flatMap(review => review.findings.map(finding => `${review.reviewerLabel}: ${finding.title} - ${finding.recommendation}`))
      .slice(0, 8);

    return [
      designContent.trim(),
      '',
      `## ${this.copy('修订说明', 'Revision Notes')}`,
      ...this.renderMarkdownList(
        topFindings.length > 0
          ? topFindings
          : [this.copy('本次自动修订未拿到更多结构化问题，建议人工对照 review 报告继续收敛。', 'No additional structured issues were available for the automatic revision. Review the report manually and continue refining.')],
        this.copy('无', 'None'),
      ),
      '',
      `## ${this.copy('剩余待确认问题', 'Remaining Open Questions')}`,
      ...this.renderMarkdownList(consensus.unresolvedQuestions, this.copy('无', 'None')),
      '',
    ].join('\n');
  }

  private ensureGeneratedDocumentOutput(content: string, label: string): string {
    const normalized = normalizeMarkdownDocument(content);
    if (!normalized.trim()) {
      throw new Error(`${label} returned empty output.`);
    }

    if (this.looksLikePermissionRequestOutput(normalized)) {
      throw new Error(`${label} returned a permission/access request instead of the document body.`);
    }

    return normalized;
  }

  private looksLikePermissionRequestOutput(content: string): boolean {
    const normalized = content.replace(/\s+/g, ' ').trim().toLowerCase();
    const leadingWindow = normalized.slice(0, 400);
    const patterns = [
      /需要写入权限/,
      /请授权/,
      /授权后/,
      /没有权限写入/,
      /write permission/,
      /need permission/,
      /need write access/,
      /need access to write/,
      /cannot update .* file/,
      /i need permission/,
      /i need write access/,
      /permission to update/,
      /permission to write/,
      /without permission i cannot/,
    ];

    return patterns.some(pattern => pattern.test(leadingWindow));
  }

  private renderReviewPrdSourceMarkdown(targetFilePath: string, prdContent: string, capturedAt: string): string {
    return [
      `# ${this.copy('PRD 评审输入快照', 'PRD Review Input Snapshot')}`,
      '',
      `- ${this.copy('源文件', 'Source File')}: ${targetFilePath}`,
      `- ${this.copy('采集时间', 'Captured At')}: ${capturedAt}`,
      '',
      `## ${this.copy('PRD 内容', 'PRD Content')}`,
      prdContent.trim(),
      '',
    ].join('\n');
  }

  private renderPrdReviewConsensusMarkdown(
    summary: ConsensusSummary,
    reviews: StructuredReview[],
    targetFilePath: string,
    revisedPrdPath?: string,
  ): string {
    return [
      `# ${this.copy('PRD 评审汇总', 'PRD Review Summary')}`,
      '',
      `- ${this.copy('目标文件', 'Target File')}: ${targetFilePath}`,
      `- ${this.copy('独立评审数', 'Independent Reviews')}: ${reviews.length}`,
      revisedPrdPath ? `- ${this.copy('修订版 PRD', 'Revised PRD')}: ${revisedPrdPath}` : '',
      '',
      `## ${this.copy('摘要', 'Summary')}`,
      summary.summary,
      '',
      `## ${this.copy('已达成共识', 'Consensus Points')}`,
      ...this.renderMarkdownList(summary.consensusPoints, this.copy('暂无。', 'None yet.')),
      '',
      `## ${this.copy('建议讨论点', 'Suggested Decision Topics')}`,
      ...(summary.conflicts.length > 0
        ? summary.conflicts.flatMap(issue => [
          `### ${issue.question}`,
          issue.whyItMatters,
          ...issue.options.map(option => `- ${option.label}: ${option.rationale}`),
          '',
        ])
        : [`- ${this.copy('未发现阻塞性冲突。', 'No blocking conflicts detected.')}`, '']),
      `## ${this.copy('未解决问题', 'Unresolved Questions')}`,
      ...this.renderMarkdownList(summary.unresolvedQuestions, this.copy('无', 'None')),
      '',
      `## ${this.copy('各 Reviewer 结论', 'Reviewer Verdicts')}`,
      ...(reviews.length > 0
        ? reviews.flatMap(review => [
          `### ${review.reviewerLabel}`,
          `- ${this.copy('视角', 'Lens')}: ${review.lens}`,
          `- ${this.copy('结论', 'Verdict')}: ${review.verdict}`,
          `- ${this.copy('摘要', 'Summary')}: ${review.summary}`,
          '',
        ])
        : [`- ${this.copy('无', 'None')}`, '']),
    ].join('\n');
  }

  private renderReviewDesignSourceMarkdown(targetFilePath: string, designContent: string, capturedAt: string): string {
    return [
      `# ${this.copy('技术设计评审输入快照', 'Technical Design Review Input Snapshot')}`,
      '',
      `- ${this.copy('源文件', 'Source File')}: ${targetFilePath}`,
      `- ${this.copy('采集时间', 'Captured At')}: ${capturedAt}`,
      '',
      `## ${this.copy('技术设计内容', 'Technical Design Content')}`,
      designContent.trim(),
      '',
    ].join('\n');
  }

  private renderDesignReviewConsensusMarkdown(
    summary: ConsensusSummary,
    reviews: StructuredReview[],
    targetFilePath: string,
    revisedDesignPath?: string,
  ): string {
    return [
      `# ${this.copy('技术设计评审汇总', 'Technical Design Review Summary')}`,
      '',
      `- ${this.copy('目标文件', 'Target File')}: ${targetFilePath}`,
      `- ${this.copy('独立评审数', 'Independent Reviews')}: ${reviews.length}`,
      revisedDesignPath ? `- ${this.copy('修订版技术设计', 'Revised Technical Design')}: ${revisedDesignPath}` : '',
      '',
      `## ${this.copy('摘要', 'Summary')}`,
      summary.summary,
      '',
      `## ${this.copy('已达成共识', 'Consensus Points')}`,
      ...this.renderMarkdownList(summary.consensusPoints, this.copy('暂无。', 'None yet.')),
      '',
      `## ${this.copy('建议讨论点', 'Suggested Decision Topics')}`,
      ...(summary.conflicts.length > 0
        ? summary.conflicts.flatMap(issue => [
          `### ${issue.question}`,
          issue.whyItMatters,
          ...issue.options.map(option => `- ${option.label}: ${option.rationale}`),
          '',
        ])
        : [`- ${this.copy('未发现阻塞性冲突。', 'No blocking conflicts detected.')}`, '']),
      `## ${this.copy('未解决问题', 'Unresolved Questions')}`,
      ...this.renderMarkdownList(summary.unresolvedQuestions, this.copy('无', 'None')),
      '',
      `## ${this.copy('各 Reviewer 结论', 'Reviewer Verdicts')}`,
      ...(reviews.length > 0
        ? reviews.flatMap(review => [
          `### ${review.reviewerLabel}`,
          `- ${this.copy('视角', 'Lens')}: ${review.lens}`,
          `- ${this.copy('结论', 'Verdict')}: ${review.verdict}`,
          `- ${this.copy('摘要', 'Summary')}: ${review.summary}`,
          '',
        ])
        : [`- ${this.copy('无', 'None')}`, '']),
    ].join('\n');
  }

  private renderMarkdownList(items: string[], emptyText: string): string[] {
    return items.length > 0 ? items.map(item => `- ${item}`) : [`- ${emptyText}`];
  }

  private renderRequirementAssessmentMarkdown(assessment: RequirementAssessment, leadSlot: EngineSlot): string {
    return [
      `# ${this.copy('需求门禁判断', 'Requirement Gate Decision')}`,
      '',
      `- ${this.copy('主 Agent', 'Lead Agent')}: ${ENGINE_LABELS[leadSlot]}`,
      `- ${this.copy('复杂度', 'Complexity')}: ${this.formatRequirementComplexity(assessment.complexity)}`,
      `- ${this.copy('清晰度', 'Clarity')}: ${this.formatRequirementClarity(assessment.clarity)}`,
      `- ${this.copy('下一步', 'Next Step')}: ${this.formatRequirementNextStep(assessment.nextStep)}`,
      '',
      `## ${this.copy('判断摘要', 'Summary')}`,
      assessment.summary,
      '',
      `## ${this.copy('判断理由', 'Reasoning')}`,
      assessment.reasoning,
      '',
      `## ${this.copy('关键风险', 'Key Risks')}`,
      ...this.renderMarkdownList(assessment.keyRisks, this.copy('无', 'None')),
      '',
      `## ${this.copy('缺失信息', 'Missing Information')}`,
      ...this.renderMarkdownList(assessment.missingInformation, this.copy('无', 'None')),
      '',
      `## ${this.copy('建议补问', 'Suggested Follow-ups')}`,
      ...this.renderMarkdownList(assessment.recommendedQuestions, this.copy('无', 'None')),
      '',
    ].join('\n');
  }

  private renderRequirementSummaryMarkdown(summaryCard: RequirementSummaryCard): string {
    return [
      `# ${this.copy('需求总结', 'Requirement Summary')}`,
      '',
      `## ${this.copy('要解决的问题', 'Problem')}`,
      summaryCard.problem,
      '',
      `## ${this.copy('目标用户', 'Target Users')}`,
      ...this.renderMarkdownList(summaryCard.targetUsers, this.copy('未明确', 'Not yet defined')),
      '',
      `## ${this.copy('期望结果', 'Desired Outcome')}`,
      summaryCard.desiredOutcome,
      '',
      `## ${this.copy('当前范围', 'In Scope')}`,
      ...this.renderMarkdownList(summaryCard.inScope, this.copy('无', 'None')),
      '',
      `## ${this.copy('暂不纳入', 'Out of Scope')}`,
      ...this.renderMarkdownList(summaryCard.outOfScope, this.copy('无', 'None')),
      '',
      `## ${this.copy('当前假设', 'Assumptions')}`,
      ...this.renderMarkdownList(summaryCard.assumptions, this.copy('无', 'None')),
      '',
      `## ${this.copy('待确认问题', 'Open Questions')}`,
      ...this.renderMarkdownList(summaryCard.openQuestions, this.copy('无', 'None')),
      '',
    ].join('\n');
  }

  private renderRequirementValidationReviewMarkdown(review: RequirementValidationReview): string {
    return [
      `# ${this.copy('复杂需求校验', 'Requirement Validation')} - ${review.reviewerLabel}`,
      '',
      `- ${this.copy('校验视角', 'Focus')}: ${review.focus}`,
      `- ${this.copy('结论', 'Verdict')}: ${review.verdict === 'clear' ? this.copy('可进入 PRD', 'Ready for PRD') : this.copy('需进一步澄清', 'Needs clarification')}`,
      `- ${this.copy('实际执行', 'Executed By')}: ${ENGINE_LABELS[review.resolvedBy]}${review.proxyUsed ? this.copy('（代理执行）', ' (fallback proxy)') : ''}`,
      '',
      `## ${this.copy('摘要', 'Summary')}`,
      review.summary,
      '',
      `## ${this.copy('疑点 / 风险', 'Concerns')}`,
      ...this.renderMarkdownList(review.concerns, this.copy('无', 'None')),
      '',
      `## ${this.copy('建议补问', 'Suggested Questions')}`,
      ...this.renderMarkdownList(review.suggestedQuestions, this.copy('无', 'None')),
      '',
      `## ${this.copy('建议动作', 'Recommended Actions')}`,
      ...this.renderMarkdownList(review.recommendedActions, this.copy('无', 'None')),
      '',
    ].join('\n');
  }

  private renderRequirementValidationSummaryMarkdown(
    summary: RequirementValidationSummary,
    reviews: RequirementValidationReview[],
  ): string {
    return [
      `# ${this.copy('复杂需求校验汇总', 'Requirement Validation Summary')}`,
      '',
      `- ${this.copy('是否可进入 PRD', 'Ready for PRD')}: ${summary.proceedToPrd ? this.copy('是', 'Yes') : this.copy('否', 'No')}`,
      '',
      `## ${this.copy('结论摘要', 'Summary')}`,
      summary.summary,
      '',
      `## ${this.copy('阻塞项', 'Blockers')}`,
      ...this.renderMarkdownList(summary.blockers, this.copy('无', 'None')),
      '',
      `## ${this.copy('建议补问', 'Suggested Follow-ups')}`,
      ...this.renderMarkdownList(summary.followUps, this.copy('无', 'None')),
      '',
      `## ${this.copy('建议动作', 'Recommended Actions')}`,
      ...this.renderMarkdownList(summary.recommendations, this.copy('无', 'None')),
      '',
      `## ${this.copy('各 Agent 结论', 'Agent Reviews')}`,
      ...(reviews.length > 0
        ? reviews.flatMap(review => [
          `### ${review.reviewerLabel}`,
          `- ${this.copy('视角', 'Focus')}: ${review.focus}`,
          `- ${this.copy('结论', 'Verdict')}: ${review.verdict === 'clear' ? this.copy('可进入 PRD', 'Ready for PRD') : this.copy('需进一步澄清', 'Needs clarification')}`,
          `- ${this.copy('摘要', 'Summary')}: ${review.summary}`,
          '',
        ])
        : [`- ${this.copy('无', 'None')}`, '']),
    ].join('\n');
  }

  private renderRequirementClarificationsMarkdown(clarifications: string[]): string {
    return [
      `# ${this.copy('需求补充澄清', 'Requirement Clarifications')}`,
      '',
      ...this.renderMarkdownList(clarifications, this.copy('无', 'None')),
      '',
    ].join('\n');
  }

  private renderRequirementPackMarkdown(pack: RequirementPack): string {
    return [
      `# ${this.copy('Requirement Pack', 'Requirement Pack')}`,
      '',
      `- ${this.copy('主 Agent', 'Lead Agent')}: ${pack.leadLabel}`,
      `- ${this.copy('批准时间', 'Approved At')}: ${pack.approvedAt}`,
      `- ${this.copy('需求总结确认', 'Summary Confirmed')}: ${pack.summaryApproved ? this.copy('是', 'Yes') : this.copy('否', 'No')}`,
      `- ${this.copy('是否经过复杂需求校验', 'Validated as Complex Requirement')}: ${pack.validationRequired ? this.copy('是', 'Yes') : this.copy('否', 'No')}`,
      '',
      `## ${this.copy('门禁判断', 'Gate Decision')}`,
      `- ${this.copy('复杂度', 'Complexity')}: ${this.formatRequirementComplexity(pack.assessment.complexity)}`,
      `- ${this.copy('清晰度', 'Clarity')}: ${this.formatRequirementClarity(pack.assessment.clarity)}`,
      `- ${this.copy('下一步', 'Next Step')}: ${this.formatRequirementNextStep(pack.assessment.nextStep)}`,
      `- ${this.copy('摘要', 'Summary')}: ${pack.assessment.summary}`,
      '',
      `## ${this.copy('Idea Brief', 'Idea Brief')}`,
      `- ${this.copy('原始想法', 'Raw Idea')}: ${pack.brief.rawIdea}`,
      `- ${this.copy('目标用户', 'Target Users')}: ${pack.brief.targetUsers}`,
      `- ${this.copy('目标', 'Goals')}:`,
      ...this.renderMarkdownList(pack.brief.goals, this.copy('无', 'None')),
      '',
      `- ${this.copy('约束', 'Constraints')}:`,
      ...this.renderMarkdownList(pack.brief.constraints, this.copy('无', 'None')),
      '',
      `- ${this.copy('成功标准', 'Success Criteria')}:`,
      ...this.renderMarkdownList(pack.brief.successCriteria, this.copy('无', 'None')),
      '',
      ...(pack.summaryCard
        ? [
          `## ${this.copy('已确认的需求总结', 'Confirmed Requirement Summary')}`,
          this.renderRequirementSummaryMarkdown(pack.summaryCard),
          '',
        ]
        : []),
      ...(pack.validationSummary
        ? [
          `## ${this.copy('复杂需求校验结论', 'Complex Requirement Validation')}`,
          this.renderRequirementValidationSummaryMarkdown(pack.validationSummary, pack.validationReviews),
          '',
        ]
        : []),
      ...(pack.userClarifications.length > 0
        ? [
          `## ${this.copy('用户补充澄清', 'User Clarifications')}`,
          ...this.renderMarkdownList(pack.userClarifications, this.copy('无', 'None')),
          '',
        ]
        : []),
    ].join('\n');
  }

  private describePrdReviewLens(slot: EngineSlot): string {
    if (slot === 'claude') {
      return this.copy(
        '产品策略 / 范围边界 / 需求完整性',
        'product strategy / scope boundaries / requirement completeness',
      );
    }

    if (slot === 'codex') {
      return this.copy(
        '实现可行性 / 技术风险 / 验收可测试性',
        'implementation feasibility / technical risk / testability of acceptance criteria',
      );
    }

    return this.copy(
      '用户价值 / 场景流畅度 / 交互期望清晰度',
      'user value / scenario flow / clarity of interaction expectations',
    );
  }

  private describeDesignReviewLens(slot: EngineSlot): string {
    if (slot === 'claude') {
      return this.copy(
        '架构边界 / 模块拆分 / 长链路权衡',
        'architecture boundaries / module decomposition / long-range tradeoffs',
      );
    }

    if (slot === 'codex') {
      return this.copy(
        '实现路径 / 数据流 / 测试与可维护性',
        'implementation path / data flow / testing and maintainability',
      );
    }

    return this.copy(
      '使用体验影响 / 交互流畅度 / 交付清晰度',
      'UX impact / interaction flow / delivery clarity',
    );
  }

  private selectDesignLead(brief: IdeaBrief): EngineSlot {
    if (this.config.routing.designLead) {
      return this.config.routing.designLead;
    }

    const haystack = [brief.rawIdea, brief.targetUsers, ...brief.goals, ...brief.constraints].join(' ').toLowerCase();
    if (/(frontend|ui|ux|landing|page|mobile|client)/.test(haystack)) {
      return 'gemini';
    }
    if (/(backend|worker|queue|db|database|api|script|cli|server)/.test(haystack)) {
      return 'codex';
    }
    return 'claude';
  }

  private applyResponseLanguage(prompt: string, mode: 'text' | 'json'): string {
    const languageLabel = this.config.language?.label || this.config.language?.code || '简体中文';
    const instruction =
      mode === 'json'
        ? `Language requirement: write every natural-language string value in ${languageLabel}. Keep JSON keys, required enum values, code, commands, file paths, and identifiers unchanged when the schema requires them.`
        : `Language requirement: respond in ${languageLabel}. Keep code, shell commands, file paths, JSON keys, API names, and identifiers unchanged when needed.`;

    return [instruction, '', prompt].join('\n');
  }

  private copy(zh: string, en: string): string {
    return localize(this.config.language, zh, en);
  }

  private reportModelFallback(title: string, fallbackMessage: string, error: unknown, debugContext?: string): void {
    ChatUI.info(title, fallbackMessage);
    this.debugModelFailure(title, error, debugContext);
  }

  private debugModelFailure(title: string, error: unknown, context?: string): void {
    ChatUI.debugError(
      title,
      error,
      context || this.copy('开发模式错误详情：', 'Dev-mode error details:'),
    );
  }

  private resolveSlot(slot: EngineSlot, avoidTargets: EngineSlot[] = []): SlotResolution {
    const preferred = this.availability[slot];
    if (preferred.available && !this.unhealthySlots.has(slot) && !avoidTargets.includes(slot)) {
      return {
        slot,
        slotLabel: ENGINE_LABELS[slot],
        resolvedBy: slot,
        resolvedLabel: ENGINE_LABELS[slot],
        proxyUsed: false,
      };
    }

    for (const candidate of this.config.routing.fallbackOrder) {
      const status = this.availability[candidate];
      if (candidate === slot || !status.available || this.unhealthySlots.has(candidate) || avoidTargets.includes(candidate)) {
        continue;
      }
      return {
        slot,
        slotLabel: ENGINE_LABELS[slot],
        resolvedBy: candidate,
        resolvedLabel: ENGINE_LABELS[candidate],
        proxyUsed: true,
      };
    }

    if (preferred.available && !this.unhealthySlots.has(slot)) {
      return {
        slot,
        slotLabel: ENGINE_LABELS[slot],
        resolvedBy: slot,
        resolvedLabel: ENGINE_LABELS[slot],
        proxyUsed: false,
      };
    }

    for (const candidate of this.config.routing.fallbackOrder) {
      const status = this.availability[candidate];
      if (!status.available || this.unhealthySlots.has(candidate)) {
        continue;
      }
      return {
        slot,
        slotLabel: ENGINE_LABELS[slot],
        resolvedBy: candidate,
        resolvedLabel: ENGINE_LABELS[candidate],
        proxyUsed: true,
      };
    }

    throw new Error(this.copy(`没有可用于槽位 ${slot} 的引擎。`, `No available engine found for slot ${slot}.`));
  }

  private async runTextForSlot(
    slot: EngineSlot,
    prompt: string,
    options: {
      allowEdits?: boolean;
      interactiveSession?: boolean;
      timeoutMs?: number;
      allowEmptyOutput?: boolean;
      allowFallbackProxy?: boolean;
      avoidTargets?: EngineSlot[];
      onStdoutChunk?: (chunk: string) => void;
      onStderrChunk?: (chunk: string) => void;
    } = {},
  ): Promise<{ resolution: SlotResolution; output: CLIExecutionResult<string> }> {
    const localizedPrompt = this.applyResponseLanguage(prompt, 'text');

    if (options.allowFallbackProxy === false) {
      const directStatus = this.availability[slot];
      if (!directStatus?.available) {
        throw new Error(directStatus?.reason || `${ENGINE_LABELS[slot]} is unavailable for direct execution.`);
      }
      if (this.unhealthySlots.has(slot)) {
        throw new Error(`${ENGINE_LABELS[slot]} is temporarily unhealthy for direct execution.`);
      }
      if (options.avoidTargets?.includes(slot)) {
        throw new Error(`${ENGINE_LABELS[slot]} cannot be used here without reusing an earlier execution target.`);
      }

      const output = await this.adapters[slot].executeText(localizedPrompt, {
        cwd: process.cwd(),
        allowEdits: options.allowEdits,
        interactiveSession: options.interactiveSession,
        timeoutMs: options.timeoutMs,
        onStdoutChunk: options.onStdoutChunk,
        onStderrChunk: options.onStderrChunk,
      });

      return {
        resolution: {
          slot,
          slotLabel: ENGINE_LABELS[slot],
          resolvedBy: slot,
          resolvedLabel: ENGINE_LABELS[slot],
          proxyUsed: false,
        },
        output,
      };
    }

    const resolution = this.resolveSlot(slot, options.avoidTargets);
    let output = await this.adapters[resolution.resolvedBy].executeText(localizedPrompt, {
      cwd: process.cwd(),
      allowEdits: options.allowEdits,
      interactiveSession: options.interactiveSession,
      timeoutMs: options.timeoutMs,
      onStdoutChunk: options.onStdoutChunk,
      onStderrChunk: options.onStderrChunk,
    });

    if (
      options.allowFallbackProxy &&
      !options.interactiveSession &&
      (output.exitCode !== 0 || (!options.allowEmptyOutput && output.stdout.trim().length === 0))
    ) {
      const failureReason =
        output.exitCode !== 0
          ? `${resolution.resolvedLabel} exited with code ${output.exitCode}`
          : `${resolution.resolvedLabel} returned empty output`;
      const stderrPreview = output.stderr.trim().slice(0, 400);
      options.onStderrChunk?.(
        this.copy(
          `${failureReason}，准备尝试代理模型。${stderrPreview ? `\n${stderrPreview}` : ''}`,
          `${failureReason}. Retrying with a fallback engine.${stderrPreview ? `\n${stderrPreview}` : ''}`,
        ) + '\n',
      );
      this.unhealthySlots.add(resolution.resolvedBy);
      const retryResolution = this.resolveSlot(slot, options.avoidTargets);
      if (retryResolution.resolvedBy !== resolution.resolvedBy) {
        output = await this.adapters[retryResolution.resolvedBy].executeText(localizedPrompt, {
          cwd: process.cwd(),
          allowEdits: options.allowEdits,
          interactiveSession: options.interactiveSession,
          timeoutMs: options.timeoutMs,
          onStdoutChunk: options.onStdoutChunk,
          onStderrChunk: options.onStderrChunk,
        });
        return { resolution: retryResolution, output };
      }
    }

    return { resolution, output };
  }

  private async runTextWithPreferredSlots(
    slots: EngineSlot[],
    prompt: string,
    options: {
      timeoutMs?: number;
      liveTitle?: string;
      heartbeatMs?: number;
      heartbeatMessage?: (slot: EngineSlot, elapsedMs: number) => string | null;
      streamStdout?: boolean;
    } = {},
  ): Promise<{ resolution: SlotResolution; output: CLIExecutionResult<string> }> {
    return this.withTransientHealth(async () => {
      let lastError: Error | null = null;
      const attemptErrors: Array<{ slot: EngineSlot; message: string }> = [];
      const streamLog =
        options.liveTitle && ChatUI.canUseInteractiveTaskSession()
          ? ChatUI.createStreamingLog(options.liveTitle)
          : null;

      if (streamLog) {
        streamLog.message(
          this.copy(
            '长文阶段可能需要几十秒到数分钟；这里会显示进度状态，正文会在完成后统一展示。',
            'Long-form generation can take from several seconds to a few minutes. Progress appears here, and the document is shown after completion.',
          ),
        );
      }

      for (const slot of unique(slots)) {
        streamLog?.message(this.copy(`正在尝试 ${ENGINE_LABELS[slot]}...`, `Trying ${ENGINE_LABELS[slot]}...`));
        streamLog?.startLoading(
          this.copy(`${ENGINE_LABELS[slot]} 正在生成内容...`, `${ENGINE_LABELS[slot]} is generating content...`),
          options.heartbeatMs && options.heartbeatMessage
            ? {
              heartbeatMs: options.heartbeatMs,
              onHeartbeat: elapsedMs => options.heartbeatMessage?.(slot, elapsedMs) || null,
            }
            : {},
        );
        try {
          const result = await this.runTextForSlot(slot, prompt, {
            timeoutMs: options.timeoutMs ?? this.config.timeouts.modelExecutionMs,
            allowFallbackProxy: true,
            onStdoutChunk: options.streamStdout ? chunk => streamLog?.stdout(chunk) : undefined,
            onStderrChunk: chunk => streamLog?.stderr(chunk),
          });
          streamLog?.stopLoading();
          if (result.resolution.proxyUsed) {
            streamLog?.message(
              this.copy(
                `${ENGINE_LABELS[result.resolution.slot]} 当前由 ${result.resolution.resolvedLabel} 代理执行。`,
                `${ENGINE_LABELS[result.resolution.slot]} is currently being proxied by ${result.resolution.resolvedLabel}.`,
              ),
            );
          }
          if (result.output.exitCode === 0 && result.output.stdout.trim().length > 0) {
            streamLog?.success(
              this.copy(
                `${options.liveTitle || '文本生成'}完成，用时 ${this.formatDurationMs(result.output.durationMs)}。`,
                `${options.liveTitle || 'Text generation'} completed in ${this.formatDurationMs(result.output.durationMs)}.`,
              ),
            );
            return result;
          }
          this.unhealthySlots.add(result.resolution.resolvedBy);
          streamLog?.message(
            this.copy(
              `${result.resolution.resolvedLabel} 已结束，但没有返回可用内容，准备尝试下一个模型。`,
              `${result.resolution.resolvedLabel} exited without usable output. Trying the next model.`,
            ),
          );
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          attemptErrors.push({ slot, message: lastError.message });
          streamLog?.stopLoading();
          streamLog?.message(
            this.copy(
              `${ENGINE_LABELS[slot]} 执行失败：${lastError.message}`,
              `${ENGINE_LABELS[slot]} failed: ${lastError.message}`,
            ),
          );
          this.debugModelFailure(
            'Text Generation Attempt',
            lastError,
            this.copy(
              `${ENGINE_LABELS[slot]} 文本生成失败。`,
              `${ENGINE_LABELS[slot]} text generation failed.`,
            ),
          );
        }
      }

      streamLog?.error(
        this.copy('所有文本生成模型都失败了，请检查上面的实时日志。', 'All text-generation models failed. Check the live log above.'),
      );
      throw this.buildAttemptFailureError(
        'All text-generation model attempts failed.',
        attemptErrors,
        lastError,
      );
    });
  }

  private formatDurationMs(durationMs: number): string {
    if (durationMs < 1000) {
      return `${durationMs}ms`;
    }

    const totalSeconds = Math.round(durationMs / 1000);
    if (totalSeconds < 60) {
      return `${totalSeconds}s`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  private async runJsonForSlot<T>(
    slot: EngineSlot,
    prompt: string,
    schema: JsonSchema,
    options: { timeoutMs?: number; avoidTargets?: EngineSlot[]; allowFallbackProxy?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ resolution: SlotResolution; output: CLIExecutionResult<T> }> {
    const localizedPrompt = this.applyResponseLanguage(prompt, 'json');

    if (options.allowFallbackProxy === false) {
      const directStatus = this.availability[slot];
      if (!directStatus?.available) {
        throw new Error(directStatus?.reason || `${ENGINE_LABELS[slot]} is unavailable for direct execution.`);
      }
      if (this.unhealthySlots.has(slot)) {
        throw new Error(`${ENGINE_LABELS[slot]} is temporarily unhealthy for direct execution.`);
      }
      if (options.avoidTargets?.includes(slot)) {
        throw new Error(`${ENGINE_LABELS[slot]} cannot be used here without reusing an earlier execution target.`);
      }

      const output = await this.adapters[slot].executeJson<T>(localizedPrompt, schema, {
        cwd: process.cwd(),
        timeoutMs: options.timeoutMs ?? this.config.timeouts.modelExecutionMs,
        signal: options.signal,
      });

      return {
        resolution: {
          slot,
          slotLabel: ENGINE_LABELS[slot],
          resolvedBy: slot,
          resolvedLabel: ENGINE_LABELS[slot],
          proxyUsed: false,
        },
        output,
      };
    }

    const resolution = this.resolveSlot(slot, options.avoidTargets);

    try {
      const output = await this.adapters[resolution.resolvedBy].executeJson<T>(localizedPrompt, schema, {
        cwd: process.cwd(),
        timeoutMs: options.timeoutMs ?? this.config.timeouts.modelExecutionMs,
        signal: options.signal,
      });
      return { resolution, output };
    } catch (error) {
      this.unhealthySlots.add(resolution.resolvedBy);
      const retryResolution = this.resolveSlot(slot, options.avoidTargets);
      if (retryResolution.resolvedBy !== resolution.resolvedBy) {
        this.debugModelFailure(
          'JSON Routing Retry',
          error,
          this.copy(
            `${resolution.resolvedLabel} 执行失败，准备改由 ${retryResolution.resolvedLabel} 重试。`,
            `${resolution.resolvedLabel} failed; retrying via ${retryResolution.resolvedLabel}.`,
          ),
        );
        const output = await this.adapters[retryResolution.resolvedBy].executeJson<T>(localizedPrompt, schema, {
          cwd: process.cwd(),
          timeoutMs: options.timeoutMs ?? this.config.timeouts.modelExecutionMs,
          signal: options.signal,
        });
        return { resolution: retryResolution, output };
      }
      throw error;
    }
  }

  private async runJsonWithPreferredSlots<T>(
    slots: EngineSlot[],
    prompt: string,
    schema: JsonSchema,
  ): Promise<{ resolution: SlotResolution; parsed: T; output: CLIExecutionResult<T> }> {
    return this.withTransientHealth(async () => {
      let lastError: Error | null = null;
      const attemptErrors: Array<{ slot: EngineSlot; message: string }> = [];

      for (const slot of slots) {
        try {
          const { resolution, output } = await this.runJsonForSlot<T>(slot, prompt, schema, {
            timeoutMs: this.config.timeouts.modelExecutionMs,
          });
          return {
            resolution,
            parsed: output.parsed as T,
            output,
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          attemptErrors.push({ slot, message: lastError.message });
          this.debugModelFailure(
            'JSON Generation Attempt',
            lastError,
            this.copy(
              `${ENGINE_LABELS[slot]} JSON 生成失败。`,
              `${ENGINE_LABELS[slot]} JSON generation failed.`,
            ),
          );
        }
      }

      throw this.buildAttemptFailureError(
        'All JSON-generation model attempts failed.',
        attemptErrors,
        lastError,
      );
    });
  }

  private async runWithLoading<T>(
    messages: { start: string; success: string; failure: string; skipped?: string },
    task: (signal?: AbortSignal) => Promise<T>,
    options: {
      heartbeatMs?: number;
      onHeartbeat?: (elapsedMs: number) => string | null;
      interrupt?: {
        key: string;
        hint: string;
        onTrigger?: () => void;
        createError?: () => Error;
      };
    } = {},
  ): Promise<T> {
    const abortController = options.interrupt ? new AbortController() : null;
    let interrupted = false;
    const spinner = ChatUI.showProgress(messages.start, {
      heartbeatMs: options.heartbeatMs,
      onHeartbeat: options.onHeartbeat,
      interrupt:
        options.interrupt && abortController
          ? {
            key: options.interrupt.key,
            hint: options.interrupt.hint,
            onTrigger: () => {
              if (interrupted) {
                return;
              }
              interrupted = true;
              options.interrupt?.onTrigger?.();
              abortController.abort(messages.skipped || `${options.interrupt?.key} requested.`);
            },
          }
          : undefined,
    });

    try {
      const result = await task(abortController?.signal);
      spinner.stop(messages.success);
      return result;
    } catch (error) {
      if (interrupted && this.isAbortError(error)) {
        spinner.stop(messages.skipped || messages.failure);
        throw options.interrupt?.createError?.() || error;
      }
      spinner.error(messages.failure);
      throw error;
    }
  }

  private async withTransientHealth<T>(fn: () => Promise<T>): Promise<T> {
    this.unhealthySlots.clear();
    try {
      return await fn();
    } finally {
      this.unhealthySlots.clear();
    }
  }

  private mustReadArtifact(filename: string): string {
    const content = this.store.readArtifact(filename);
    if (!content) {
      throw new Error(`Missing required artifact: ${filename}`);
    }
    return content;
  }

  private mustReadJson<T>(filename: string): T {
    const content = this.store.readJson<T>(filename);
    if (!content) {
      throw new Error(`Missing required JSON artifact: ${filename}`);
    }
    return content;
  }

  private buildSlotPreference(primary: EngineSlot, stage: RoutingStagePreferenceKey = 'default'): EngineSlot[] {
    return unique([primary, ...this.stageSlotPreference(stage)]);
  }

  private stageSlotPreference(stage: RoutingStagePreferenceKey): EngineSlot[] {
    return unique([
      ...(this.config.routing.stagePreferences[stage] || []),
      ...(stage === 'default' ? [] : this.config.routing.stagePreferences.default || []),
      ...this.config.routing.fallbackOrder,
      ...ALL_SLOTS,
    ]);
  }

  private buildAttemptFailureError(
    summary: string,
    attemptErrors: Array<{ slot: EngineSlot; message: string }>,
    lastError: Error | null,
  ): Error {
    if (attemptErrors.length === 0) {
      return lastError || new Error(summary);
    }

    const details = attemptErrors.map(({ slot, message }) => {
      const normalized = truncate(message.replace(/\s+/g, ' ').trim(), 220);
      return `- ${ENGINE_LABELS[slot]}: ${normalized}`;
    });

    return new Error([summary, ...details].join('\n'));
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  private isUserSkippedReviewError(error: unknown): error is UserSkippedReviewError {
    return error instanceof UserSkippedReviewError;
  }

  private isManualReviewPauseDecision(option: { value?: string; label?: string }): boolean {
    const value = (option.value || '').trim().toLowerCase();
    const label = (option.label || '').trim().toLowerCase();

    if (value === 'pause_for_manual_review' || label === 'pause for manual review') {
      return true;
    }

    return value.includes('manual_review') && value.includes('pause')
      || label.includes('manual review') && label.includes('pause');
  }

  private appendManualReviewFeedback(feedback: string): string {
    const filePath = this.store.getArtifactPath('manual-review-feedback.md');
    const timestamp = nowIso();
    const entry = [`## ${timestamp}`, '', feedback.trim(), ''].join('\n');
    const existing = this.store.readArtifact('manual-review-feedback.md');

    if (existing) {
      this.store.saveArtifact('manual-review-feedback.md', `${existing.trim()}\n\n${entry}`);
    } else {
      this.store.saveArtifact(
        'manual-review-feedback.md',
        [`# ${this.copy('人工复核意见', 'Manual Review Feedback')}`, '', entry].join('\n'),
      );
    }

    return filePath;
  }

  private buildTechDesignReviewPacket(
    designDraft: string,
    reviews: StructuredReview[],
    consensus: ConsensusSummary,
    plan: RoundtablePlan,
    minutes: RoundtableMinutes,
    manualReviewFeedback: string,
  ): string {
    const reviewSections = reviews.flatMap(review => [
      `### ${review.reviewerLabel}`,
      `- ${this.copy('视角', 'Lens')}: ${review.lens}`,
      `- ${this.copy('结论', 'Verdict')}: ${review.verdict}`,
      `- ${this.copy('摘要', 'Summary')}: ${review.summary}`,
      ...(review.findings.length > 0
        ? review.findings.slice(0, 3).map(
          finding => `- ${finding.severity.toUpperCase()}: ${finding.title} | ${finding.recommendation}`,
        )
        : [`- ${this.copy('未记录关键问题。', 'No notable findings were recorded.')}`]),
      '',
    ]);

    return [
      `# ${this.copy('技术设计复核包', 'Technical Design Review Packet')}`,
      '',
      `## ${this.copy('关联产物', 'Related Artifacts')}`,
      `- ${this.copy('技术设计草稿', 'Technical design draft')}: ${this.store.getArtifactPath('tech-design-draft.md')}`,
      `- ${this.copy('独立评审汇总', 'Consensus report')}: ${this.store.getArtifactPath('consensus-report.md')}`,
      `- ${this.copy('圆桌逐轮记录', 'Roundtable transcript')}: ${this.store.getArtifactPath('roundtable-transcript.md')}`,
      `- ${this.copy('圆桌纪要', 'Roundtable minutes')}: ${this.store.getArtifactPath('roundtable-minutes.md')}`,
      '',
      `## ${this.copy('复核摘要', 'Review Summary')}`,
      `- ${this.copy('共识摘要', 'Consensus summary')}: ${plan.summary || consensus.summary}`,
      `- ${this.copy('候选决策数', 'Decision options')}: ${minutes.decisionOptions.length}`,
      `- ${this.copy('建议优先关注', 'Recommended focus')}: ${Math.max(minutes.recommendations.length, plan.unresolvedQuestions.length)}`,
      '',
      `## ${this.copy('独立评审摘要', 'Independent Review Summary')}`,
      ...(reviewSections.length > 0 ? reviewSections : [`- ${this.copy('无', 'None')}`, '']),
      `## ${this.copy('圆桌建议', 'Roundtable Recommendations')}`,
      ...(minutes.recommendations.length > 0
        ? minutes.recommendations.map(item => `- ${item}`)
        : [`- ${this.copy('无', 'None')}`]),
      '',
      `## ${this.copy('未解决风险', 'Unresolved Risks')}`,
      ...(minutes.unresolvedRisks.length > 0
        ? minutes.unresolvedRisks.map(item => `- ${item}`)
        : [`- ${this.copy('无', 'None')}`]),
      '',
      `## ${this.copy('当前决策选项', 'Current Decision Options')}`,
      ...minutes.decisionOptions.map(option => `- ${option.label}: ${option.rationale}`),
      '',
      ...(manualReviewFeedback
        ? [
          `## ${this.copy('已记录的人工复核意见', 'Captured Manual Review Feedback')}`,
          manualReviewFeedback,
          '',
        ]
        : []),
      `## ${this.copy('当前技术设计全文', 'Full Technical Design')}`,
      designDraft.trim(),
      '',
    ].join('\n');
  }
}
