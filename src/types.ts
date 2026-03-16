export type EngineSlot = 'claude' | 'codex' | 'gemini';

export type SetupMode = 'default' | 'custom';

export type RoutingStagePreferenceKey =
  | 'default'
  | 'idea'
  | 'prd'
  | 'techDesign'
  | 'roundtablePlan'
  | 'roundtableMinutes'
  | 'finalDesign'
  | 'taskPlan'
  | 'integrationReview';

export type ReviewVerdict = 'Approve' | 'Needs Discussion' | 'Reject';

export type TaskDomain =
  | 'frontend'
  | 'backend'
  | 'architecture'
  | 'integration'
  | 'testing'
  | 'data'
  | 'docs'
  | 'ops';

export interface IdeaBrief {
  rawIdea: string;
  targetUsers: string;
  goals: string[];
  constraints: string[];
  nonGoals: string[];
  successCriteria: string[];
  assumptions: string[];
  followUps: string[];
}

export type IdeaFollowUpIntent =
  | 'targetUsers'
  | 'constraints'
  | 'successCriteria'
  | 'goals'
  | 'nonGoals'
  | 'assumptions'
  | 'workflow'
  | 'integration'
  | 'delivery'
  | 'other';

export interface IdeaFollowUpQuestion {
  id: string;
  intent: IdeaFollowUpIntent;
  message: string;
  placeholder: string;
  required: boolean;
}

export interface IdeaFollowUpAnswer extends IdeaFollowUpQuestion {
  answer: string;
}

export interface IdeaIntakeAnswers {
  rawIdea: string;
  followUps: IdeaFollowUpAnswer[];
}

export type RequirementComplexity = 'low' | 'medium' | 'high';

export type RequirementClarity = 'clear' | 'needs_confirmation' | 'needs_clarification';

export type RequirementNextStep = 'generate_prd' | 'confirm_summary' | 'confirm_summary_and_validate';

export interface RequirementAssessment {
  summary: string;
  complexity: RequirementComplexity;
  clarity: RequirementClarity;
  reasoning: string;
  keyRisks: string[];
  missingInformation: string[];
  recommendedQuestions: string[];
  shouldConfirmSummary: boolean;
  shouldDelegateValidation: boolean;
  nextStep: RequirementNextStep;
}

export interface RequirementSummaryCard {
  problem: string;
  targetUsers: string[];
  desiredOutcome: string;
  inScope: string[];
  outOfScope: string[];
  assumptions: string[];
  openQuestions: string[];
}

export type RequirementValidationVerdict = 'clear' | 'needs_clarification';

export interface RequirementValidationReview {
  reviewer: EngineSlot;
  reviewerLabel: string;
  resolvedBy: EngineSlot;
  proxyUsed: boolean;
  focus: string;
  verdict: RequirementValidationVerdict;
  summary: string;
  concerns: string[];
  suggestedQuestions: string[];
  recommendedActions: string[];
  rawOutput: string;
}

export interface RequirementValidationSummary {
  summary: string;
  proceedToPrd: boolean;
  blockers: string[];
  followUps: string[];
  recommendations: string[];
}

export interface RequirementPack {
  leadSlot: EngineSlot;
  leadLabel: string;
  approvedAt: string;
  brief: IdeaBrief;
  assessment: RequirementAssessment;
  summaryCard?: RequirementSummaryCard;
  summaryApproved: boolean;
  validationRequired: boolean;
  validationReviews: RequirementValidationReview[];
  validationSummary?: RequirementValidationSummary;
  userClarifications: string[];
}

export interface ReviewFinding {
  title: string;
  severity: 'low' | 'medium' | 'high';
  confidence: number;
  details: string;
  recommendation: string;
}

export interface StructuredReview {
  reviewer: EngineSlot;
  reviewerLabel: string;
  resolvedBy: EngineSlot;
  proxyUsed: boolean;
  lens: string;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  openQuestions: string[];
  suggestedDecision: string;
  rawOutput: string;
}

export interface ConsensusIssueOption {
  value: string;
  label: string;
  rationale: string;
}

export interface ConsensusIssue {
  id: string;
  question: string;
  whyItMatters: string;
  options: ConsensusIssueOption[];
}

export interface ConsensusSummary {
  summary: string;
  consensusPoints: string[];
  conflicts: ConsensusIssue[];
  unresolvedQuestions: string[];
}

export interface RoundtablePlan {
  launchRoundtable: boolean;
  summary: string;
  consensusPoints: string[];
  unresolvedQuestions: string[];
  issues: ConsensusIssue[];
}

export interface RoundtableTurn {
  round: number;
  issueId: string;
  agent: EngineSlot;
  agentLabel: string;
  resolvedBy: EngineSlot;
  proxyUsed: boolean;
  message: string;
}

export interface DecisionOption {
  value: string;
  label: string;
  rationale: string;
}

export interface RoundtableMinutes {
  summary: string;
  decisionOptions: DecisionOption[];
  recommendations: string[];
  unresolvedRisks: string[];
}

export type DevelopmentAction = 'stop_after_design' | 'start_development';

export type DevelopmentMode = 'single_terminal' | 'multi_terminal';

export interface DevelopmentStrategy {
  action: DevelopmentAction;
  actionLabel: string;
  mode?: DevelopmentMode;
  modeLabel?: string;
  singleTerminalEngine?: EngineSlot;
  singleTerminalEngineLabel?: string;
  decidedAt: string;
}

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  domain: TaskDomain;
  dependsOn: string[];
  acceptanceCriteria: string[];
  recommendedOwner: EngineSlot;
  recommendedReviewer: EngineSlot;
  filesToTouch: string[];
  implementationSteps: string[];
  verificationSteps: string[];
  reviewFocus: string[];
  suggestedCommitMessage: string;
}

export interface TaskGraph {
  tasks: TaskNode[];
  executionOrder: string[];
}

export type TaskReviewStatus = 'approved' | 'needs_changes' | 'failed';

export interface TaskReviewRecord {
  reviewer: EngineSlot;
  resolvedBy: EngineSlot;
  proxyUsed: boolean;
  status: TaskReviewStatus;
  rounds: number;
  reviewedAt: string;
  summary: string;
  findings: ReviewFinding[];
  openQuestions: string[];
  rawOutput: string;
}

export interface TaskRunRecord {
  taskId: string;
  owner: EngineSlot;
  reviewer: EngineSlot;
  resolvedBy: EngineSlot;
  proxyUsed: boolean;
  status: 'done' | 'warning' | 'failed' | 'skipped';
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  changedFiles: string[];
  summary: string;
  rawOutput: string;
  review?: TaskReviewRecord;
}

export interface LocalCheckResult {
  name: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface IntegrationReview {
  summary: string;
  completedTasks: string[];
  failedTasks: string[];
  remainingRisks: string[];
  suggestedTests: string[];
  handoffNotes: string[];
}

export interface SessionState {
  sessionId: string;
  createdAt: string;
  workspace: string;
  currentStage?: string;
  stages: Record<string, { status: 'pending' | 'running' | 'completed' | 'failed'; updatedAt: string; note?: string }>;
}

export interface WorkspaceSnapshot {
  capturedAt: string;
  files: Record<string, number>;
}

export interface JsonSchema {
  [key: string]: unknown;
}

export interface EngineCommandConfig {
  command?: string;
  args?: string[];
  candidates?: string[];
}

export interface ReplyLanguageConfig {
  code: string;
  label: string;
}

export interface EngineDetectionStatus {
  available: boolean;
  command?: string;
  reason?: string;
  candidates: string[];
}

export interface SetupConfig {
  completed: boolean;
  mode?: SetupMode;
  initializedAt?: string;
  detectedEngines: Partial<Record<EngineSlot, EngineDetectionStatus>>;
}

export interface AegisConfig {
  dryRun: boolean;
  setup: SetupConfig;
  language: ReplyLanguageConfig;
  routing: {
    designLead?: EngineSlot;
    fallbackOrder: EngineSlot[];
    domainOwners: Record<TaskDomain, EngineSlot>;
    stagePreferences: Partial<Record<RoutingStagePreferenceKey, EngineSlot[]>>;
  };
  engines: Partial<Record<EngineSlot, EngineCommandConfig>>;
}

export interface SlotResolution {
  slot: EngineSlot;
  slotLabel: string;
  resolvedBy: EngineSlot;
  resolvedLabel: string;
  proxyUsed: boolean;
}
