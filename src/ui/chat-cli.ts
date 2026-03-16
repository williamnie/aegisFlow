import { spawnSync } from 'child_process';

import * as p from '@clack/prompts';
import chalk from 'chalk';

import { IdeaFollowUpAnswer, IdeaFollowUpQuestion } from '../types';

export class ChatUI {
  private static readonly debugMode = ChatUI.detectDebugMode();

  static abort(message: string = 'Operation cancelled.', exitCode: number = 0): never {
    p.cancel(message);
    process.exit(exitCode);
  }

  static resolvePrompt<T>(value: T): T {
    if (p.isCancel(value)) {
      this.abort();
    }

    return value;
  }

  static resolveTextPrompt(value: unknown): string {
    const response = this.resolvePrompt(value);

    if (typeof response === 'string' && response.trim().toLowerCase() === '/exit') {
      this.abort();
    }

    return response as string;
  }

  static async startSession(message: string = 'AegisFlow Orchestrator Starting...') {
    p.intro(chalk.bgBlue.white.bold(` ${message} `));
  }

  static async endSession(message: string = 'Session Complete') {
    p.outro(chalk.green(`✔ ${message}`));
  }

  static stage(title: string, detail?: string | string[]) {
    const body = Array.isArray(detail) ? detail.filter(Boolean).join('\n') : detail || '';
    p.note(body, chalk.blueBright(title));
  }

  static async askIdeaSeed(): Promise<string> {
    return this.resolveTextPrompt(await p.text({
      message: '你想让 AegisFlow 帮你实现什么项目或目标？',
      placeholder: '例如：做一个能协作生成 PRD、设计和代码的多 Agent CLI',
      validate: value => (!value ? '请输入一个初始想法' : undefined),
    }));
  }

  static async askIdeaFollowUps(questions: IdeaFollowUpQuestion[]): Promise<IdeaFollowUpAnswer[]> {
    const answers: IdeaFollowUpAnswer[] = [];

    for (const question of questions) {
      const answer = this.resolveTextPrompt(await p.text({
        message: question.message,
        placeholder: question.placeholder,
        validate: value => {
          if (!question.required) {
            return undefined;
          }

          return !value ? '请补充这个问题的回答' : undefined;
        },
      }));

      answers.push({
        ...question,
        answer,
      });
    }

    return answers;
  }

  static async askIdeaFallbackDetails(): Promise<IdeaFollowUpAnswer[]> {
    return this.askIdeaFollowUps([
      {
        id: 'target-users',
        intent: 'targetUsers',
        message: '这个项目主要给谁用？',
        placeholder: '例如：独立开发者 / 小团队负责人',
        required: true,
      },
      {
        id: 'constraints',
        intent: 'constraints',
        message: '有没有关键约束、非目标或技术边界？',
        placeholder: '例如：只做 CLI，不做 Web；必须本地执行；今晚能跑通 MVP',
        required: true,
      },
      {
        id: 'success-criteria',
        intent: 'successCriteria',
        message: '你怎么判断这次交付算成功？',
        placeholder: '例如：能跑完 0-7 阶段，并且真的改动仓库文件',
        required: true,
      },
    ]);
  }

  static formatIdeaIntakePreview(rawIdea: string, answers: IdeaFollowUpAnswer[]): string {
    const lines = [`初始想法：${rawIdea}`];

    if (answers.length > 0) {
      lines.push('');
      lines.push('补充信息：');
      for (const item of answers) {
        lines.push(`- ${item.message}`);
        lines.push(`  ${item.answer}`);
      }
    }

    return lines.join('\n');
  }

  static showArtifact(title: string, contentPreview: string, filePath?: string) {
    const lines = [contentPreview];

    if (filePath) {
      lines.push('');
      lines.push(`全文已保存到: ${filePath}`);
      lines.push(`可在分页器中查看: less ${this.shellQuote(filePath)}`);
    }

    p.note(lines.join('\n'), title);
  }

  static async inspectArtifact(title: string, filePath: string): Promise<void> {
    const shouldOpen = this.resolvePrompt(await p.confirm({
      message: `是否先在分页器中查看完整的 ${title}？`,
      initialValue: true,
    }));

    if (!shouldOpen) {
      return;
    }

    const pager = process.env.PAGER || 'less';
    const result = spawnSync(`${pager} ${this.shellQuote(filePath)}`, [], {
      stdio: 'inherit',
      shell: true,
    });

    if (result.error || result.status === 127) {
      p.note(
        `无法启动分页器，请手动打开文件查看：\n${filePath}`,
        chalk.yellow(`${title} Full View Unavailable`),
      );
    }
  }

  static async confirm(message: string, initialValue: boolean = true): Promise<boolean> {
    const response = this.resolvePrompt(await p.confirm({
      message,
      initialValue,
    }));
    return response as boolean;
  }

  static async showApproval(title: string): Promise<boolean> {
    const response = this.resolvePrompt(await p.confirm({
      message: `请确认 ${title} 是否可以进入下一阶段。`,
      initialValue: true,
    }));
    return response as boolean;
  }

  static async askRevisionRequest(title: string): Promise<string> {
    const response = this.resolveTextPrompt(await p.text({
      message: `请说明 ${title} 需要怎么修改`,
      placeholder: '例如：补充成功标准、压缩范围、明确不做项',
      validate: value => (!value ? '请输入修改意见' : undefined),
    }));

    return response;
  }

  static async renderRoundtableMessage(agentName: string, message: string, colorFn: (text: string) => string) {
    p.note(message, colorFn(`[${agentName}]`));
    await this.delay(250);
  }

  static async askRoundtableDecision(options: { value: string, label: string }[]): Promise<string> {
    const decision = this.resolvePrompt(await p.select({
      message: '请根据圆桌讨论结果选择最终方案：',
      options,
    }));
    return decision as string;
  }

  static async askPostDesignAction(): Promise<'start_development' | 'stop_after_design'> {
    const action = this.resolvePrompt(await p.select({
      message: '技术设计已完成，下一步要怎么做？',
      options: [
        { value: 'start_development', label: '立即开始开发' },
        { value: 'stop_after_design', label: '先停在技术设计阶段' },
      ],
    }));
    return action as 'start_development' | 'stop_after_design';
  }

  static async askDevelopmentMode(): Promise<'single_terminal' | 'multi_terminal'> {
    const mode = this.resolvePrompt(await p.select({
      message: '请选择开发模式：',
      options: [
        { value: 'single_terminal', label: '单一终端开发' },
        { value: 'multi_terminal', label: '多终端协作开发' },
      ],
    }));
    return mode as 'single_terminal' | 'multi_terminal';
  }

  static async askSingleTerminalEngine(options: { value: string, label: string }[]): Promise<string> {
    const engine = this.resolvePrompt(await p.select({
      message: '单一终端开发要固定使用哪个程序？',
      options,
    }));
    return engine as string;
  }

  static showProgress(
    message: string,
    options: {
      heartbeatMs?: number;
      onHeartbeat?: (elapsedMs: number) => string | null;
      interrupt?: {
        key: string;
        hint: string;
        onTrigger: () => void;
      };
    } = {},
  ) {
    const s = p.spinner();
    s.start(message);
    const startedAt = Date.now();
    const stdin = process.stdin;
    const heartbeat =
      options.heartbeatMs && options.onHeartbeat
        ? setInterval(() => {
          const next = options.onHeartbeat?.(Date.now() - startedAt);
          if (next) {
            p.log.message(chalk.dim(`[progress] ${next}`));
          }
        }, options.heartbeatMs)
        : null;
    const canUseInterrupt = Boolean(options.interrupt && process.stdin.isTTY && process.stdout.isTTY);
    const priorRawMode = stdin.isTTY ? stdin.isRaw === true : false;
    const wasPaused = typeof stdin.isPaused === 'function' ? stdin.isPaused() : false;
    let interruptTriggered = false;
    let interruptHandler: ((chunk: Buffer | string) => void) | null = null;

    const clearHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    };

    const clearInterrupt = () => {
      if (!interruptHandler) {
        return;
      }

      stdin.removeListener('data', interruptHandler);
      interruptHandler = null;
      if (stdin.isTTY) {
        stdin.setRawMode(priorRawMode);
      }
      if (wasPaused) {
        stdin.pause();
      }
    };

    if (canUseInterrupt && options.interrupt) {
      p.log.message(
        `${chalk.black.bgYellowBright.bold(' SHORTCUT ')} ${chalk.yellowBright.bold(options.interrupt.hint)}`,
      );
      interruptHandler = chunk => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        if (text === '\u0003') {
          clearInterrupt();
          process.kill(process.pid, 'SIGINT');
          return;
        }

        if (interruptTriggered) {
          return;
        }

        if (text.trim().toLowerCase() !== options.interrupt?.key.trim().toLowerCase()) {
          return;
        }

        interruptTriggered = true;
        options.interrupt.onTrigger();
      };
      stdin.on('data', interruptHandler);
      stdin.resume();
      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
    }

    return {
      stop(successMessage: string) {
        clearHeartbeat();
        clearInterrupt();
        s.stop(successMessage);
      },
      error(errorMessage: string) {
        clearHeartbeat();
        clearInterrupt();
        s.error(errorMessage);
      },
      message(nextMessage: string) {
        s.message(nextMessage);
      },
    };
  }

  static createStreamingLog(title: string, options: { limit?: number } = {}) {
    p.log.step(title);
    const pending = {
      stdout: '',
      stderr: '',
    } as Record<'stdout' | 'stderr', string>;
    const loading = p.spinner();
    let lastPrinted = '';
    let loadingActive = false;
    let loadingStartedAt = 0;
    let loadingHeartbeat: ReturnType<typeof setInterval> | null = null;

    const writeLine = (kind: 'stdout' | 'stderr', line: string) => {
      const cleaned = line.trim();
      if (!cleaned) {
        return;
      }

      const rendered = kind === 'stderr' ? `[stderr] ${cleaned}` : cleaned;
      if (rendered === lastPrinted) {
        return;
      }

      lastPrinted = rendered;
      p.log.message(kind === 'stderr' ? chalk.yellow(rendered) : rendered);
    };

    const clearLoading = () => {
      if (!loadingActive) {
        return;
      }

      if (loadingHeartbeat) {
        clearInterval(loadingHeartbeat);
        loadingHeartbeat = null;
      }

      loading.clear();
      loadingActive = false;
    };

    const flush = (kind: 'stdout' | 'stderr', force = false) => {
      const normalized = pending[kind].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = normalized.split('\n');
      pending[kind] = lines.pop() || '';

      for (const line of lines) {
        writeLine(kind, line);
      }

      if (force && pending[kind]) {
        writeLine(kind, pending[kind]);
        pending[kind] = '';
        return;
      }

      if (!force && pending[kind].length >= 80) {
        writeLine(kind, pending[kind]);
        pending[kind] = '';
      }
    };

    return {
      startLoading(
        message: string,
        heartbeatOptions: { heartbeatMs?: number; onHeartbeat?: (elapsedMs: number) => string | null } = {},
      ) {
        if (loadingHeartbeat) {
          clearInterval(loadingHeartbeat);
          loadingHeartbeat = null;
        }

        if (heartbeatOptions.heartbeatMs && heartbeatOptions.onHeartbeat) {
          loadingStartedAt = Date.now();
          loadingHeartbeat = setInterval(() => {
            const next = heartbeatOptions.onHeartbeat?.(Date.now() - loadingStartedAt);
            if (next) {
              writeLine('stdout', `[progress] ${next}`);
            }
          }, heartbeatOptions.heartbeatMs);
        }

        if (loadingActive) {
          loading.message(message);
          return;
        }

        loading.start(message);
        loadingActive = true;
      },
      stopLoading() {
        clearLoading();
      },
      message(message: string) {
        writeLine('stdout', message);
      },
      stdout(chunk: string) {
        clearLoading();
        pending.stdout += chunk;
        flush('stdout');
      },
      stderr(chunk: string) {
        clearLoading();
        pending.stderr += chunk;
        flush('stderr');
      },
      success(message: string) {
        clearLoading();
        flush('stdout', true);
        flush('stderr', true);
        lastPrinted = '';
        p.log.success(message);
      },
      error(message: string) {
        clearLoading();
        flush('stdout', true);
        flush('stderr', true);
        lastPrinted = '';
        p.log.error(message);
      },
    };
  }

  static canUseInteractiveTaskSession(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }

  static info(title: string, content: string) {
    p.note(content, title);
  }

  static isDebugMode(): boolean {
    return this.debugMode;
  }

  static debug(title: string, content: string) {
    if (!this.isDebugMode()) {
      return;
    }

    p.note(content, chalk.yellow(`${title} [dev]`));
  }

  static debugError(title: string, error: unknown, context?: string) {
    if (!this.isDebugMode()) {
      return;
    }

    const normalized = error instanceof Error ? error : new Error(String(error));
    const details = normalized.stack || normalized.message || String(error);
    const lines = [
      context,
      details,
    ].filter(Boolean);
    p.note(lines.join('\n\n'), chalk.yellow(`${title} [dev]`));
  }

  private static delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private static detectDebugMode(): boolean {
    const lifecycleEvent = process.env.npm_lifecycle_event || '';
    return lifecycleEvent === 'dev';
  }

  private static shellQuote(value: string) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}
