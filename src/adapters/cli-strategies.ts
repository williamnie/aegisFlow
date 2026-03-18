import fs from 'fs';
import os from 'os';

import { EngineCommandConfig, EngineSlot } from '../types';
import { stripAnsi } from '../utils';
import { CLIExecutionOptions } from './base';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hasArg(args: string[], ...flags: string[]): boolean {
  return flags.some(flag => args.includes(flag));
}

interface StructuredStreamSnapshot {
  lastMessage: string | null;
  diagnostics: string[];
}

export interface StructuredStreamParser {
  pushStdout(chunk: string): void;
  flush(): void;
  snapshot(): StructuredStreamSnapshot;
}

export interface StrategyBuildArgsInput {
  prompt: string;
  outputFile: string;
  schemaFile?: string;
  allowEdits: boolean;
  interactiveSession: boolean;
  useStructuredStream: boolean;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface CLIExecutionStrategy {
  shouldUseStructuredStream(options: CLIExecutionOptions): boolean;
  buildArgs(input: StrategyBuildArgsInput): string[];
  buildSpawnSpec(command: string, args: string[], tempDir: string): SpawnSpec;
  createStructuredParser(options: CLIExecutionOptions): StructuredStreamParser | null;
}

interface StructuredStreamState {
  pendingStdout: string;
  lastMessage: string | null;
  diagnostics: string[];
  fallbackToRawStdout: boolean;
}

// Preserve each CLI's existing auth/config lookup instead of isolating it in a temp home.
function buildInheritedCliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: process.env.HOME || process.env.USERPROFILE || os.homedir(),
  };
}

abstract class BaseStructuredStreamParser implements StructuredStreamParser {
  private readonly state: StructuredStreamState = {
    pendingStdout: '',
    lastMessage: null,
    diagnostics: [],
    fallbackToRawStdout: false,
  };

  constructor(
    protected readonly name: string,
    protected readonly options: CLIExecutionOptions,
  ) {}

  pushStdout(chunk: string): void {
    if (this.state.fallbackToRawStdout) {
      this.options.onStdoutChunk?.(stripAnsi(chunk));
      return;
    }

    this.state.pendingStdout += chunk;
    const lines = this.state.pendingStdout.split('\n');
    this.state.pendingStdout = lines.pop() || '';

    for (const line of lines) {
      this.processLine(line);
      if (this.state.fallbackToRawStdout) {
        return;
      }
    }
  }

  flush(): void {
    if (this.state.fallbackToRawStdout) {
      if (this.state.pendingStdout) {
        this.options.onStdoutChunk?.(stripAnsi(this.state.pendingStdout));
      }
      this.state.pendingStdout = '';
      return;
    }

    if (!this.state.pendingStdout.trim()) {
      this.state.pendingStdout = '';
      return;
    }

    this.processLine(this.state.pendingStdout);
    this.state.pendingStdout = '';
  }

  snapshot(): StructuredStreamSnapshot {
    return {
      lastMessage: this.state.lastMessage,
      diagnostics: [...this.state.diagnostics],
    };
  }

  protected appendAssistantDelta(chunk: string): void {
    if (!chunk) {
      return;
    }

    this.state.lastMessage = `${this.state.lastMessage || ''}${chunk}`;
    this.options.onStdoutChunk?.(chunk);
  }

  protected replaceAssistantSnapshot(snapshot: string): void {
    if (!snapshot) {
      return;
    }

    const previous = this.state.lastMessage || '';
    if (!previous) {
      this.state.lastMessage = snapshot;
      this.options.onStdoutChunk?.(snapshot);
      return;
    }

    if (snapshot === previous) {
      return;
    }

    if (previous.startsWith(snapshot)) {
      return;
    }

    if (snapshot.startsWith(previous)) {
      const suffix = snapshot.slice(previous.length);
      this.state.lastMessage = snapshot;
      if (suffix) {
        this.options.onStdoutChunk?.(suffix);
      }
      return;
    }

    const commonPrefixLength = this.commonPrefixLength(previous, snapshot);
    const suffix = snapshot.slice(commonPrefixLength);
    this.state.lastMessage = snapshot;
    if (suffix) {
      this.options.onStdoutChunk?.(suffix);
    }
  }

  protected setFinalMessage(message: string): void {
    this.state.lastMessage = message;
  }

  protected pushDiagnostic(message: string): void {
    this.state.diagnostics.push(message);
    this.options.onStderrChunk?.(`${message}\n`);
  }

  protected asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  protected extractStringField(record: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }

      if (Array.isArray(value)) {
        const joined = value
          .map(item => {
            if (typeof item === 'string') {
              return item;
            }

            const child = this.asRecord(item);
            if (!child) {
              return '';
            }

            return this.extractStringField(child, ['text', 'content', 'message', 'delta', 'result', 'response']) || '';
          })
          .filter(Boolean)
          .join('');

        if (joined.trim()) {
          return joined;
        }
      }

      const child = this.asRecord(value);
      if (child) {
        const nested = this.extractStringField(child, ['text', 'content', 'message', 'delta', 'result', 'response']);
        if (nested) {
          return nested;
        }
      }
    }

    return null;
  }

  private processLine(line: string): void {
    const trimmed = stripAnsi(line).trim();
    if (!trimmed) {
      return;
    }

    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const handled = this.handleRecord(record);
      if (!handled) {
        this.enableRawFallback(line);
      }
    } catch {
      this.enableRawFallback(line);
    }
  }

  private enableRawFallback(line: string): void {
    this.state.fallbackToRawStdout = true;
    this.pushDiagnostic(`${this.name} structured streaming could not be parsed. Falling back to raw stdout.`);
    this.options.onStdoutChunk?.(`${stripAnsi(line)}\n`);
  }

  protected abstract handleRecord(record: Record<string, unknown>): boolean;

  private commonPrefixLength(left: string, right: string): number {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) {
      index += 1;
    }

    return index;
  }
}

class CodexStructuredStreamParser extends BaseStructuredStreamParser {
  protected handleRecord(record: Record<string, unknown>): boolean {
    const type = typeof record.type === 'string' ? record.type : null;
    if (!type) {
      return false;
    }

    if (type === 'error') {
      const message = typeof record.message === 'string' ? record.message : null;
      if (message) {
        this.pushDiagnostic(message);
      }
      return true;
    }

    // Newer Codex CLI builds can forward Responses API text deltas directly.
    if (type === 'response.output_text.delta') {
      const delta = this.extractStringField(record, ['delta', 'text']);
      if (delta) {
        this.appendAssistantDelta(delta);
      }
      return true;
    }

    if (type === 'response.output_text.done') {
      const text = this.extractStringField(record, ['text', 'delta']);
      if (text) {
        this.replaceAssistantSnapshot(text);
      }
      return true;
    }

    if (type === 'event_msg' || type === 'response_item') {
      const payload = this.asRecord(record.payload);
      return payload ? this.handlePayload(payload) : true;
    }

    // Handle item-level events from the Codex Responses API.
    // item.completed may carry the final agent_message with the task result.
    if (type === 'item.completed' || type === 'item.updated') {
      const item = this.asRecord(record.item);
      if (item) {
        const itemType = typeof item.type === 'string' ? item.type : null;
        if (itemType === 'agent_message') {
          const text = this.extractStringField(item, ['text', 'message', 'content']);
          if (text) {
            this.replaceAssistantSnapshot(text);
          }
        }
      }
      return true;
    }

    return type.includes('.');
  }

  private handlePayload(payload: Record<string, unknown>): boolean {
    const payloadType = typeof payload.type === 'string' ? payload.type : null;
    if (!payloadType) {
      return false;
    }

    if (payloadType === 'agent_message_delta') {
      const delta = this.extractStringField(payload, ['delta', 'text', 'message', 'content']);
      if (delta) {
        this.appendAssistantDelta(delta);
      }
      return true;
    }

    if (payloadType === 'agent_message') {
      const message = this.extractStringField(payload, ['message', 'text', 'content']);
      if (message) {
        this.replaceAssistantSnapshot(message);
      }
      return true;
    }

    if (payloadType === 'task_complete') {
      const lastMessage = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : null;
      if (lastMessage) {
        this.setFinalMessage(lastMessage);
      }
      return true;
    }

    if (payloadType === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
      const message = payload.content
        .map(item => {
          const part = this.asRecord(item);
          return part?.type === 'output_text' && typeof part.text === 'string' ? part.text : '';
        })
        .filter(Boolean)
        .join('');
      if (message) {
        this.replaceAssistantSnapshot(message);
      }
      return true;
    }

    return [
      'task_started',
      'token_count',
      'reasoning',
      'agent_reasoning',
      'user_message',
      'custom_tool_call',
      'custom_tool_call_output',
      'web_search_call',
      'context_compacted',
      'item_completed',
    ].includes(payloadType);
  }
}

class GeminiStructuredStreamParser extends BaseStructuredStreamParser {
  protected handleRecord(record: Record<string, unknown>): boolean {
    const type = typeof record.type === 'string' ? record.type : null;
    if (!type) {
      return false;
    }

    if (type === 'message') {
      const role = typeof record.role === 'string' ? record.role : null;
      const content = typeof record.content === 'string' ? record.content : null;
      if (role === 'assistant' && content) {
        if (record.delta === true) {
          this.appendAssistantDelta(content);
        } else {
          this.replaceAssistantSnapshot(content);
        }
      }
      return true;
    }

    if (type === 'error') {
      const message = typeof record.message === 'string' ? record.message : null;
      if (message) {
        this.pushDiagnostic(message);
      }
      return true;
    }

    if (type === 'result') {
      const error = this.asRecord(record.error);
      if (error && typeof error.message === 'string') {
        this.pushDiagnostic(error.message);
      }
      return true;
    }

    if (type === 'tool_result') {
      const error = this.asRecord(record.error);
      if (error && typeof error.message === 'string') {
        this.pushDiagnostic(error.message);
      }
      return true;
    }

    return ['init', 'tool_use'].includes(type);
  }
}

class ClaudeStructuredStreamParser extends BaseStructuredStreamParser {
  protected handleRecord(record: Record<string, unknown>): boolean {
    const type = typeof record.type === 'string' ? record.type : null;
    if (!type) {
      return false;
    }

    if (type === 'assistant') {
      const message = this.asRecord(record.message);
      if (!message) {
        return true;
      }

      const textContent = this.extractClaudeTextContent(message);
      if (textContent) {
        this.replaceAssistantSnapshot(textContent);
      }

      return true;
    }

    if (type === 'stream_event') {
      const event = this.asRecord(record.event);
      return event ? this.handleStreamEvent(event) : true;
    }

    if (type === 'result') {
      const content = this.extractStringField(record, ['content', 'result', 'response']);
      if (content) {
        this.setFinalMessage(content);
      }

      if (record.is_error === true) {
        const errorMessage = this.extractStringField(record, ['result', 'message', 'error']);
        if (errorMessage) {
          this.pushDiagnostic(errorMessage);
        }
      }
      return true;
    }

    if (type === 'system') {
      const content = this.extractStringField(record, ['content', 'message']);
      if (content) {
        this.pushDiagnostic(content);
      }
      return true;
    }

    return ['user', 'queue-operation', 'last-prompt'].includes(type);
  }

  private handleStreamEvent(event: Record<string, unknown>): boolean {
    const eventType = typeof event.type === 'string' ? event.type : null;
    if (!eventType) {
      return false;
    }

    if (eventType === 'content_block_start') {
      const block = this.asRecord(event.content_block);
      const text = block?.type === 'text' && typeof block.text === 'string' ? block.text : null;
      if (text) {
        this.appendAssistantDelta(text);
      }
      return true;
    }

    if (eventType === 'content_block_delta') {
      const delta = this.asRecord(event.delta);
      if (!delta) {
        return true;
      }

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.appendAssistantDelta(delta.text);
      }
      return true;
    }

    return ['message_start', 'content_block_stop', 'message_delta', 'message_stop'].includes(eventType);
  }

  private extractClaudeTextContent(message: Record<string, unknown>): string | null {
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map(item => {
        const part = this.asRecord(item);
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
      })
      .filter(Boolean)
      .join('');

    if (text.trim()) {
      return text;
    }

    return this.extractStringField(message, ['text', 'content']);
  }
}

class CodexExecutionStrategy implements CLIExecutionStrategy {
  private readonly userArgs: string[];

  constructor(config: EngineCommandConfig) {
    this.userArgs = config.args || [];
  }

  shouldUseStructuredStream(options: CLIExecutionOptions): boolean {
    return options.interactiveSession !== true && Boolean(options.onStdoutChunk || options.onStderrChunk);
  }

  buildArgs(input: StrategyBuildArgsInput): string[] {
    const args = [
      ...(!hasArg(this.userArgs, '-a', '--ask-for-approval', '--full-auto', '--dangerously-bypass-approvals-and-sandbox') &&
      input.interactiveSession
        ? ['-a', 'on-request']
        : []),
      ...(input.interactiveSession ? ['--no-alt-screen'] : []),
      'exec',
      '--skip-git-repo-check',
      '--color',
      'never',
      ...(!input.allowEdits && !hasArg(this.userArgs, '-s', '--sandbox') ? ['--sandbox', 'read-only'] : []),
      ...(input.useStructuredStream && !hasArg(this.userArgs, '--json') ? ['--json'] : []),
      '-o',
      input.outputFile,
      ...this.userArgs,
    ];
    if (input.schemaFile) {
      args.push('--output-schema', input.schemaFile);
    }
    args.push(input.prompt);
    return args;
  }

  buildSpawnSpec(command: string, args: string[], _tempDir: string): SpawnSpec {
    return {
      command,
      args,
      env: buildInheritedCliEnv(),
    };
  }

  createStructuredParser(options: CLIExecutionOptions): StructuredStreamParser | null {
    return this.shouldUseStructuredStream(options) ? new CodexStructuredStreamParser('Codex', options) : null;
  }
}

class ClaudeExecutionStrategy implements CLIExecutionStrategy {
  private readonly userArgs: string[];

  constructor(config: EngineCommandConfig) {
    this.userArgs = config.args || [];
  }

  shouldUseStructuredStream(options: CLIExecutionOptions): boolean {
    return options.interactiveSession !== true && Boolean(options.onStdoutChunk || options.onStderrChunk);
  }

  buildArgs(input: StrategyBuildArgsInput): string[] {
    const args = ['-p', ...this.userArgs];
    if (
      !input.allowEdits &&
      !hasArg(this.userArgs, '--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools')
    ) {
      args.push('--tools', '');
    }
    if (!input.allowEdits && !hasArg(this.userArgs, '--permission-mode')) {
      args.push('--permission-mode', 'dontAsk');
    }
    if (
      input.allowEdits &&
      !hasArg(
        this.userArgs,
        '--permission-mode',
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
      )
    ) {
      args.push('--permission-mode', input.interactiveSession ? 'default' : 'auto');
    }

    if (input.schemaFile) {
      const schemaArg = JSON.stringify(JSON.parse(fs.readFileSync(input.schemaFile, 'utf-8')));
      args.push('--output-format', 'json', '--json-schema', schemaArg);
    } else if (input.useStructuredStream && !hasArg(this.userArgs, '--output-format')) {
      args.push('--output-format', 'stream-json', '--include-partial-messages');
      if (!hasArg(this.userArgs, '--verbose')) {
        args.push('--verbose');
      }
    }

    args.push(input.prompt);
    return args;
  }

  buildSpawnSpec(command: string, args: string[], _tempDir: string): SpawnSpec {
    return {
      command: process.env.SHELL || '/bin/sh',
      args: ['-lc', `${shellQuote(command)} ${args.map(shellQuote).join(' ')}`],
      env: buildInheritedCliEnv(),
    };
  }

  createStructuredParser(options: CLIExecutionOptions): StructuredStreamParser | null {
    return this.shouldUseStructuredStream(options) ? new ClaudeStructuredStreamParser('Claude', options) : null;
  }
}

class GeminiExecutionStrategy implements CLIExecutionStrategy {
  private readonly userArgs: string[];

  constructor(config: EngineCommandConfig) {
    this.userArgs = config.args || [];
  }

  shouldUseStructuredStream(options: CLIExecutionOptions): boolean {
    return options.interactiveSession !== true && Boolean(options.onStdoutChunk || options.onStderrChunk);
  }

  buildArgs(input: StrategyBuildArgsInput): string[] {
    const args = [...this.userArgs];
    if (input.allowEdits && !hasArg(args, '--approval-mode', '--yolo', '-y')) {
      args.push('--approval-mode', input.interactiveSession ? 'default' : 'auto_edit');
    }

    if (input.schemaFile) {
      args.push('--output-format', 'json');
    } else if (input.useStructuredStream && !hasArg(args, '--output-format', '-o')) {
      args.push('--output-format', 'stream-json');
    }

    args.push('--prompt', input.prompt);
    return args;
  }

  buildSpawnSpec(command: string, args: string[], _tempDir: string): SpawnSpec {
    return { command, args, env: buildInheritedCliEnv() };
  }

  createStructuredParser(options: CLIExecutionOptions): StructuredStreamParser | null {
    return this.shouldUseStructuredStream(options) ? new GeminiStructuredStreamParser('Gemini', options) : null;
  }
}

export function createCLIExecutionStrategy(slot: EngineSlot, config: EngineCommandConfig): CLIExecutionStrategy {
  switch (slot) {
    case 'codex':
      return new CodexExecutionStrategy(config);
    case 'claude':
      return new ClaudeExecutionStrategy(config);
    case 'gemini':
      return new GeminiExecutionStrategy(config);
    default:
      throw new Error(`Unsupported engine slot: ${slot}`);
  }
}
