export const IDEA_BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rawIdea: { type: 'string' },
    targetUsers: { type: 'string' },
    goals: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    nonGoals: { type: 'array', items: { type: 'string' } },
    successCriteria: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    followUps: { type: 'array', items: { type: 'string' } },
  },
  required: ['rawIdea', 'targetUsers', 'goals', 'constraints', 'nonGoals', 'successCriteria', 'assumptions', 'followUps'],
};

export const IDEA_FOLLOW_UP_QUESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          intent: {
            type: 'string',
            enum: [
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
            ],
          },
          message: { type: 'string' },
          placeholder: { type: 'string' },
          required: { type: 'boolean' },
        },
        required: ['id', 'intent', 'message', 'placeholder', 'required'],
      },
    },
  },
  required: ['questions'],
};

export const REQUIREMENT_ASSESSMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
    clarity: { type: 'string', enum: ['clear', 'needs_confirmation', 'needs_clarification'] },
    reasoning: { type: 'string' },
    keyRisks: { type: 'array', items: { type: 'string' } },
    missingInformation: { type: 'array', items: { type: 'string' } },
    recommendedQuestions: { type: 'array', items: { type: 'string' } },
    shouldConfirmSummary: { type: 'boolean' },
    shouldDelegateValidation: { type: 'boolean' },
    nextStep: { type: 'string', enum: ['generate_prd', 'confirm_summary', 'confirm_summary_and_validate'] },
  },
  required: [
    'summary',
    'complexity',
    'clarity',
    'reasoning',
    'keyRisks',
    'missingInformation',
    'recommendedQuestions',
    'shouldConfirmSummary',
    'shouldDelegateValidation',
    'nextStep',
  ],
};

export const REQUIREMENT_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    problem: { type: 'string' },
    targetUsers: { type: 'array', items: { type: 'string' } },
    desiredOutcome: { type: 'string' },
    inScope: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['problem', 'targetUsers', 'desiredOutcome', 'inScope', 'outOfScope', 'assumptions', 'openQuestions'],
};

export const REQUIREMENT_VALIDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    focus: { type: 'string' },
    verdict: { type: 'string', enum: ['clear', 'needs_clarification'] },
    summary: { type: 'string' },
    concerns: { type: 'array', items: { type: 'string' } },
    suggestedQuestions: { type: 'array', items: { type: 'string' } },
    recommendedActions: { type: 'array', items: { type: 'string' } },
  },
  required: ['focus', 'verdict', 'summary', 'concerns', 'suggestedQuestions', 'recommendedActions'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['Approve', 'Needs Discussion', 'Reject'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          confidence: { type: 'number' },
          details: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['title', 'severity', 'confidence', 'details', 'recommendation'],
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
    suggestedDecision: { type: 'string' },
  },
  required: ['lens', 'verdict', 'summary', 'findings', 'openQuestions', 'suggestedDecision'],
};

export const ROUNDTABLE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    launchRoundtable: { type: 'boolean' },
    summary: { type: 'string' },
    consensusPoints: { type: 'array', items: { type: 'string' } },
    unresolvedQuestions: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          whyItMatters: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                value: { type: 'string' },
                label: { type: 'string' },
                rationale: { type: 'string' },
              },
              required: ['value', 'label', 'rationale'],
            },
          },
        },
        required: ['id', 'question', 'whyItMatters', 'options'],
      },
    },
  },
  required: ['launchRoundtable', 'summary', 'consensusPoints', 'unresolvedQuestions', 'issues'],
};

export const ROUNDTABLE_MINUTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    decisionOptions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string' },
          label: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['value', 'label', 'rationale'],
      },
    },
    recommendations: { type: 'array', items: { type: 'string' } },
    unresolvedRisks: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'decisionOptions', 'recommendations', 'unresolvedRisks'],
};

export const TASK_GRAPH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          domain: {
            type: 'string',
            enum: ['frontend', 'backend', 'architecture', 'integration', 'testing', 'data', 'docs', 'ops'],
          },
          dependsOn: { type: 'array', items: { type: 'string' } },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          recommendedOwner: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
          recommendedReviewer: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
          filesToTouch: { type: 'array', items: { type: 'string' } },
          implementationSteps: { type: 'array', items: { type: 'string' } },
          verificationSteps: { type: 'array', items: { type: 'string' } },
          reviewFocus: { type: 'array', items: { type: 'string' } },
          suggestedCommitMessage: { type: 'string' },
        },
        required: [
          'id',
          'title',
          'description',
          'domain',
          'dependsOn',
          'acceptanceCriteria',
          'recommendedOwner',
          'recommendedReviewer',
          'filesToTouch',
        ],
      },
    },
  },
  required: ['tasks'],
};

export const TASK_EXECUTION_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['approve', 'needs_changes'] },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          confidence: { type: 'number' },
          details: { type: 'string' },
          recommendation: { type: 'string' },
        },
        required: ['title', 'severity', 'confidence', 'details', 'recommendation'],
      },
    },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['decision', 'summary', 'findings', 'openQuestions'],
};

export const INTEGRATION_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    completedTasks: { type: 'array', items: { type: 'string' } },
    failedTasks: { type: 'array', items: { type: 'string' } },
    remainingRisks: { type: 'array', items: { type: 'string' } },
    suggestedTests: { type: 'array', items: { type: 'string' } },
    handoffNotes: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'completedTasks', 'failedTasks', 'remainingRisks', 'suggestedTests', 'handoffNotes'],
};
