import {
  ConsensusSummary,
  IdeaBrief,
  IntegrationReview,
  LocalCheckResult,
  ReplyLanguageConfig,
  RoundtableMinutes,
  RoundtablePlan,
  RoundtableTurn,
  StructuredReview,
  TaskGraph,
  TaskRunRecord,
} from '../types';
import { localize } from '../i18n';

function severityWeight(level: 'low' | 'medium' | 'high'): number {
  if (level === 'high') {
    return 3;
  }
  if (level === 'medium') {
    return 2;
  }
  return 1;
}

function t(language: ReplyLanguageConfig | undefined, zh: string, en: string): string {
  return localize(language, zh, en);
}

export class ConsensusEngine {
  static renderIdeaBriefMarkdown(brief: IdeaBrief, language?: ReplyLanguageConfig): string {
    return [
      `# ${t(language, '想法简报', 'Idea Brief')}`,
      '',
      `## ${t(language, '原始想法', 'Raw Idea')}`,
      brief.rawIdea,
      '',
      `## ${t(language, '目标用户', 'Target Users')}`,
      brief.targetUsers,
      '',
      `## ${t(language, '目标', 'Goals')}`,
      ...brief.goals.map(item => `- ${item}`),
      '',
      `## ${t(language, '约束', 'Constraints')}`,
      ...brief.constraints.map(item => `- ${item}`),
      '',
      `## ${t(language, '不做项', 'Non-Goals')}`,
      ...brief.nonGoals.map(item => `- ${item}`),
      '',
      `## ${t(language, '成功标准', 'Success Criteria')}`,
      ...brief.successCriteria.map(item => `- ${item}`),
      '',
      `## ${t(language, '假设', 'Assumptions')}`,
      ...brief.assumptions.map(item => `- ${item}`),
      '',
      `## ${t(language, '待跟进问题', 'Follow-ups')}`,
      ...brief.followUps.map(item => `- ${item}`),
      '',
    ].join('\n');
  }

  static renderReviewMarkdown(review: StructuredReview, language?: ReplyLanguageConfig): string {
    return [
      `# ${t(language, '评审', 'Review')} - ${review.reviewerLabel}`,
      '',
      `- ${t(language, '角色槽位', 'Slot')}: ${review.reviewer}`,
      `- ${t(language, '实际执行', 'Executed By')}: ${review.resolvedBy}${review.proxyUsed ? t(language, '（代理执行）', ' (fallback proxy)') : ''}`,
      `- ${t(language, '视角', 'Lens')}: ${review.lens}`,
      `- ${t(language, '结论', 'Verdict')}: ${review.verdict}`,
      '',
      `## ${t(language, '摘要', 'Summary')}`,
      review.summary,
      '',
      `## ${t(language, '发现', 'Findings')}`,
      ...(review.findings.length > 0
        ? review.findings.flatMap(item => [
            `### ${item.title}`,
            `- ${t(language, '严重级别', 'Severity')}: ${item.severity}`,
            `- ${t(language, '置信度', 'Confidence')}: ${item.confidence}`,
            `${item.details}`,
            `${t(language, '建议', 'Recommendation')}: ${item.recommendation}`,
            '',
          ])
        : [`- ${t(language, '暂无阻塞性问题。', 'No blocking findings.')}`, '']),
      `## ${t(language, '开放问题', 'Open Questions')}`,
      ...(review.openQuestions.length > 0 ? review.openQuestions.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
      '',
      `## ${t(language, '建议决策', 'Suggested Decision')}`,
      review.suggestedDecision,
      '',
    ].join('\n');
  }

  static summarizeReviews(reviews: StructuredReview[], language?: ReplyLanguageConfig): ConsensusSummary {
    const consensusPoints: string[] = [];
    const unresolvedQuestions = reviews.flatMap(review => review.openQuestions).filter(Boolean);

    const allFindings = reviews.flatMap(review =>
      review.findings.map(finding => ({
        reviewer: review.reviewerLabel,
        title: finding.title,
        severity: finding.severity,
        details: finding.details,
      })),
    );

    if (reviews.every(review => review.verdict === 'Approve')) {
      consensusPoints.push(t(language, '所有评审都认可当前设计方向。', 'All reviewers approved the current design direction.'));
    }

    const conflicts =
      reviews.some(review => review.verdict !== 'Approve') || allFindings.length > 0
        ? [
            {
              id: 'design-conflict-1',
              question: t(
                language,
                '当前技术设计应该直接进入执行，还是先修改后再开始开发？',
                'Should the current technical design move forward as-is or be revised before execution?',
              ),
              whyItMatters: t(
                language,
                '这会直接影响我们是立即编码，还是先补齐设计缺口再开始执行。',
                'This decision affects whether coding starts immediately or the design is updated to close review gaps first.',
              ),
              options: [
                {
                  value: 'proceed',
                  label: t(language, '按当前设计继续推进', 'Proceed with current design'),
                  rationale: t(
                    language,
                    '当前评审问题风险较低，或可以在实现阶段逐步解决。',
                    'Review findings are low risk or can be addressed during implementation.',
                  ),
                },
                {
                  value: 'revise',
                  label: t(language, '先修订设计再编码', 'Revise design before coding'),
                  rationale: t(
                    language,
                    '存在应该在执行前就达成一致的设计风险。',
                    'There are design risks that should be settled before execution begins.',
                  ),
                },
              ],
            },
          ]
        : [];

    const highRiskFindings = allFindings
      .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
      .slice(0, 5)
      .map(item => `${item.reviewer}: ${item.title} - ${item.details}`);

    return {
      summary:
        highRiskFindings.length > 0
          ? `${t(language, '重点评审关注点', 'Top review concerns')}:\n- ${highRiskFindings.join('\n- ')}`
          : t(language, '当前评审集合中未发现重大冲突。', 'No major conflicts were detected in the current review set.'),
      consensusPoints,
      conflicts,
      unresolvedQuestions,
    };
  }

  static renderConsensusMarkdown(summary: ConsensusSummary, reviews: StructuredReview[], language?: ReplyLanguageConfig): string {
    return [
      `# ${t(language, '共识报告', 'Consensus Report')}`,
      '',
      `## ${t(language, '摘要', 'Summary')}`,
      summary.summary,
      '',
      `## ${t(language, '已达成共识', 'Consensus Points')}`,
      ...(summary.consensusPoints.length > 0 ? summary.consensusPoints.map(item => `- ${item}`) : [`- ${t(language, '暂无。', 'None yet.')}`]),
      '',
      `## ${t(language, '冲突议题', 'Conflict Topics')}`,
      ...(summary.conflicts.length > 0
        ? summary.conflicts.flatMap(issue => [
            `### ${issue.question}`,
            issue.whyItMatters,
            ...issue.options.map(option => `- ${option.label}: ${option.rationale}`),
            '',
          ])
        : [`- ${t(language, '未发现阻塞性冲突。', 'No blocking conflicts detected.')}`, '']),
      `## ${t(language, '未解决问题', 'Unresolved Questions')}`,
      ...(summary.unresolvedQuestions.length > 0 ? summary.unresolvedQuestions.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
      '',
      `## ${t(language, '评审结论', 'Review Verdicts')}`,
      ...reviews.map(review => `- ${review.reviewerLabel}: ${review.verdict}`),
      '',
    ].join('\n');
  }

  static renderRoundtableTranscript(plan: RoundtablePlan, turns: RoundtableTurn[], language?: ReplyLanguageConfig): string {
    const lines = [`# ${t(language, '圆桌讨论记录', 'Roundtable Transcript')}`, '', `## ${t(language, '议程', 'Agenda')}`, plan.summary, ''];

    for (const issue of plan.issues) {
      lines.push(`## ${issue.question}`);
      lines.push(issue.whyItMatters);
      lines.push('');

      const issueTurns = turns.filter(turn => turn.issueId === issue.id);
      for (const turn of issueTurns) {
        lines.push(
          `### ${t(language, '第', 'Round ')}${turn.round}${t(language, '轮', '')} - ${turn.agentLabel}${turn.proxyUsed ? ` ${t(language, '由', 'via')} ${turn.resolvedBy}` : ''}`,
        );
        lines.push(turn.message);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  static renderRoundtableMinutes(minutes: RoundtableMinutes, language?: ReplyLanguageConfig): string {
    return [
      `# ${t(language, '圆桌纪要', 'Roundtable Minutes')}`,
      '',
      `## ${t(language, '摘要', 'Summary')}`,
      minutes.summary,
      '',
      `## ${t(language, '决策选项', 'Decision Options')}`,
      ...minutes.decisionOptions.map(option => `- ${option.label}: ${option.rationale}`),
      '',
      `## ${t(language, '建议', 'Recommendations')}`,
      ...minutes.recommendations.map(item => `- ${item}`),
      '',
      `## ${t(language, '未解决风险', 'Unresolved Risks')}`,
      ...(minutes.unresolvedRisks.length > 0 ? minutes.unresolvedRisks.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
      '',
    ].join('\n');
  }

  static renderImplementationPlan(taskGraph: TaskGraph, language?: ReplyLanguageConfig): string {
    return [
      `# ${t(language, '实施计划', 'Implementation Plan')}`,
      '',
      `## ${t(language, '执行顺序', 'Execution Order')}`,
      ...taskGraph.executionOrder.map((taskId, index) => `${index + 1}. ${taskId}`),
      '',
      `## ${t(language, '任务', 'Tasks')}`,
      ...taskGraph.tasks.flatMap(task => [
        `### ${task.id} - ${task.title}`,
        `- ${t(language, '领域', 'Domain')}: ${task.domain}`,
        `- ${t(language, 'Owner', 'Owner')}: ${task.recommendedOwner}`,
        `- ${t(language, 'Reviewer', 'Reviewer')}: ${task.recommendedReviewer}`,
        `- ${t(language, '依赖', 'Depends On')}: ${task.dependsOn.length > 0 ? task.dependsOn.join(', ') : t(language, '无', 'None')}`,
        `- ${t(language, '建议提交信息', 'Suggested Commit')}: ${task.suggestedCommitMessage}`,
        '',
        `#### ${t(language, '描述', 'Description')}`,
        task.description,
        '',
        `#### ${t(language, '文件', 'Files')}`,
        ...(task.filesToTouch.length > 0 ? task.filesToTouch.map(item => `- ${item}`) : [`- ${t(language, '待定', 'TBD')}`]),
        '',
        `#### ${t(language, '验收标准', 'Acceptance Criteria')}`,
        ...(task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
        '',
        `#### ${t(language, '执行清单', 'Execution Checklist')}`,
        ...(task.implementationSteps.length > 0 ? task.implementationSteps.map(item => `- [ ] ${item}`) : [`- [ ] ${t(language, '补充实现步骤。', 'Add implementation steps.')}`]),
        '',
        `#### ${t(language, '验证清单', 'Verification Checklist')}`,
        ...(task.verificationSteps.length > 0 ? task.verificationSteps.map(item => `- [ ] ${item}`) : [`- [ ] ${t(language, '补充验证步骤。', 'Add verification steps.')}`]),
        '',
        `#### ${t(language, 'Reviewer 关注点', 'Reviewer Focus')}`,
        ...(task.reviewFocus.length > 0 ? task.reviewFocus.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
        '',
      ]),
    ].join('\n');
  }

  static renderIntegrationReview(review: IntegrationReview, checks: LocalCheckResult[], language?: ReplyLanguageConfig): string {
    return [
      `# ${t(language, '集成复核', 'Integration Review')}`,
      '',
      `## ${t(language, '摘要', 'Summary')}`,
      review.summary,
      '',
      `## ${t(language, '已完成任务', 'Completed Tasks')}`,
      ...(review.completedTasks.length > 0 ? review.completedTasks.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
      '',
      `## ${t(language, '失败任务', 'Failed Tasks')}`,
      ...(review.failedTasks.length > 0 ? review.failedTasks.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
      '',
      `## ${t(language, '剩余风险', 'Remaining Risks')}`,
      ...(review.remainingRisks.length > 0 ? review.remainingRisks.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
      '',
      `## ${t(language, '建议测试', 'Suggested Tests')}`,
      ...(review.suggestedTests.length > 0 ? review.suggestedTests.map(item => `- ${item}`) : [`- ${t(language, '无', 'None')}`]),
      '',
      `## ${t(language, '本地检查', 'Local Checks')}`,
      ...(checks.length > 0
        ? checks.flatMap(check => [
            `### ${check.name}`,
            `- ${t(language, '命令', 'Command')}: ${check.command}`,
            `- ${t(language, '退出码', 'Exit Code')}: ${check.exitCode}`,
            '',
          ])
        : [`- ${t(language, '没有执行本地检查。', 'No local checks were executed.')}`, '']),
    ].join('\n');
  }

  static renderDeliverySummary(
    review: IntegrationReview,
    taskGraph: TaskGraph,
    taskRuns: TaskRunRecord[],
    changedFiles: string[],
    language?: ReplyLanguageConfig,
  ): string {
    return [
      `# ${t(language, '交付总结', 'Delivery Summary')}`,
      '',
      `- ${t(language, '计划任务数', 'Tasks Planned')}: ${taskGraph.tasks.length}`,
      `- ${t(language, '已执行任务数', 'Tasks Executed')}: ${taskRuns.length}`,
      `- ${t(language, '变更文件数', 'Files Changed')}: ${changedFiles.length}`,
      '',
      `## ${t(language, '亮点', 'Highlights')}`,
      ...review.handoffNotes.map(item => `- ${item}`),
      '',
      `## ${t(language, '变更文件', 'Changed Files')}`,
      ...(changedFiles.length > 0 ? changedFiles.map(item => `- ${item}`) : [`- ${t(language, '未检测到文件变更。', 'No file changes detected.')}`]),
      '',
    ].join('\n');
  }

  static renderFinalHandoff(review: IntegrationReview, checks: LocalCheckResult[], language?: ReplyLanguageConfig): string {
    const successfulChecks = checks.filter(check => check.exitCode === 0).map(check => check.name);
    const failedChecks = checks.filter(check => check.exitCode !== 0).map(check => check.name);

    return [
      `# ${t(language, '最终交接', 'Final Handoff')}`,
      '',
      `## ${t(language, '明早快速开始', 'Tomorrow Morning Quick Start')}`,
      ...review.suggestedTests.map(item => `- ${item}`),
      '',
      `## ${t(language, '建议后续动作', 'Recommended Follow-ups')}`,
      ...review.handoffNotes.map(item => `- ${item}`),
      '',
      `## ${t(language, '检查状态', 'Check Status')}`,
      `- ${t(language, '通过', 'Passed')}: ${successfulChecks.length > 0 ? successfulChecks.join(', ') : t(language, '无', 'None')}`,
      `- ${t(language, '失败', 'Failed')}: ${failedChecks.length > 0 ? failedChecks.join(', ') : t(language, '无', 'None')}`,
      '',
    ].join('\n');
  }
}
