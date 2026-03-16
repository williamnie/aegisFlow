import { spawn } from 'child_process';
import fs from 'fs';
import * as nodePty from 'node-pty';
import os from 'os';
import path from 'path';

import { detectEngine } from '../engine-discovery';
import { EngineCommandConfig, EngineSlot, JsonSchema } from '../types';
import { extractJsonBlock, stripAnsi } from '../utils';
import { CLIExecutionStrategy, createCLIExecutionStrategy } from './cli-strategies';
import { AdapterStatus, BaseCLIAdapter, CLIExecutionOptions, CLIExecutionResult } from './base';

function ensureTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisflow-'));
  return dir;
}

type ManagedSignal = NodeJS.Signals | 'SIGKILL';

interface ActiveChildProcess {
  pid: number | undefined;
  description: string;
  terminate: (signal: ManagedSignal, reason: string) => void;
}

const activeChildProcesses = new Map<number, ActiveChildProcess>();
let nextActiveChildId = 1;
let signalHandlersInstalled = false;
let reEmittingParentSignal = false;
let sigintHandler: (() => void) | null = null;
let sigtermHandler: (() => void) | null = null;

function isSubprocessDebugEnabled(): boolean {
  const lifecycleEvent = process.env.npm_lifecycle_event || '';
  return lifecycleEvent === 'dev';
}

function emitSubprocessDebug(message: string): void {
  if (!isSubprocessDebugEnabled()) {
    return;
  }

  process.stderr.write(`[aegisflow child] ${message}\n`);
}

function formatSubprocessError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createAbortError(name: string, reason?: unknown): Error {
  const message =
    typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : reason instanceof Error && reason.message
        ? reason.message
        : `${name} aborted.`;
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function detectFatalStderrSignal(slot: EngineSlot, stderr: string): string | null {
  if (slot !== 'gemini') {
    return null;
  }

  const normalized = stderr.toLowerCase();
  if (
    normalized.includes('model_capacity_exhausted')
    || normalized.includes('no capacity available for model')
    || normalized.includes('resource_exhausted')
  ) {
    return 'Gemini reported model capacity exhaustion';
  }

  return null;
}

function terminateAllActiveChildren(signal: ManagedSignal, reason: string): number {
  const active = Array.from(activeChildProcesses.values());
  for (const child of active) {
    emitSubprocessDebug(`${child.description} pid=${child.pid ?? 'unknown'} terminating via ${signal} (${reason}).`);
    child.terminate(signal, reason);
  }
  return active.length;
}

function uninstallParentSignalHandlers(): void {
  if (!signalHandlersInstalled) {
    return;
  }

  if (sigintHandler) {
    process.removeListener('SIGINT', sigintHandler);
  }
  if (sigtermHandler) {
    process.removeListener('SIGTERM', sigtermHandler);
  }

  sigintHandler = null;
  sigtermHandler = null;
  signalHandlersInstalled = false;
  reEmittingParentSignal = false;
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function installParentSignalHandlers(): void {
  if (signalHandlersInstalled) {
    return;
  }

  const handleSignal = (signal: NodeJS.Signals) => {
    if (reEmittingParentSignal) {
      return;
    }

    reEmittingParentSignal = true;
    const terminated = terminateAllActiveChildren('SIGTERM', `parent ${signal}`);
    emitSubprocessDebug(`parent received ${signal}; terminating ${terminated} active child process(es).`);
    uninstallParentSignalHandlers();
    setImmediate(() => {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(signalExitCode(signal));
      }
    });
  };

  sigintHandler = () => handleSignal('SIGINT');
  sigtermHandler = () => handleSignal('SIGTERM');
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  signalHandlersInstalled = true;
}

function registerActiveChildProcess(child: ActiveChildProcess): () => void {
  const id = nextActiveChildId++;
  activeChildProcesses.set(id, child);
  installParentSignalHandlers();

  return () => {
    activeChildProcesses.delete(id);
    if (activeChildProcesses.size === 0) {
      uninstallParentSignalHandlers();
    }
  };
}

function buildMockValue(schema: JsonSchema, propertyName = 'value'): unknown {
  const type = schema.type;

  if (type === 'object') {
    const properties = (schema.properties || {}) as Record<string, JsonSchema>;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      result[key] = buildMockValue(value, key);
    }
    return result;
  }

  if (type === 'array') {
    const itemSchema = (schema.items || { type: 'string' }) as JsonSchema;
    return [buildMockValue(itemSchema, propertyName)];
  }

  if (type === 'number' || type === 'integer') {
    return 0.8;
  }

  if (type === 'boolean') {
    return true;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  return `${propertyName}-mock`;
}

function normalizeJsonSchema(schema: JsonSchema): JsonSchema {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  const normalized: Record<string, unknown> = { ...schema };

  if (normalized.type === 'object') {
    const properties = (normalized.properties || {}) as Record<string, JsonSchema>;
    normalized.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, normalizeJsonSchema(value)]),
    );
    if (normalized.additionalProperties === undefined) {
      normalized.additionalProperties = false;
    }
  }

  if (normalized.type === 'array' && normalized.items) {
    normalized.items = normalizeJsonSchema(normalized.items as JsonSchema);
  }

  return normalized as JsonSchema;
}

function describeValueType(value: unknown): string {
  if (Array.isArray(value)) {
    return 'array';
  }

  if (value === null) {
    return 'null';
  }

  return typeof value;
}

function validateSchemaValue(value: unknown, schema: JsonSchema, pointer = 'response'): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return null;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.includes(value)) {
    return `${pointer} must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`;
  }

  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return `${pointer} must be an object, received ${describeValueType(value)}`;
      }

      const record = value as Record<string, unknown>;
      const properties = (schema.properties || {}) as Record<string, JsonSchema>;
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

      for (const key of required) {
        if (!(key in record)) {
          return `${pointer}.${key} is required`;
        }
      }

      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in properties)) {
            return `${pointer}.${key} is not allowed`;
          }
        }
      }

      for (const [key, childSchema] of Object.entries(properties)) {
        if (!(key in record)) {
          continue;
        }

        const error = validateSchemaValue(record[key], childSchema, `${pointer}.${key}`);
        if (error) {
          return error;
        }
      }

      return null;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return `${pointer} must be an array, received ${describeValueType(value)}`;
      }

      const itemSchema = (schema.items || { type: 'string' }) as JsonSchema;
      for (const [index, item] of value.entries()) {
        const error = validateSchemaValue(item, itemSchema, `${pointer}[${index}]`);
        if (error) {
          return error;
        }
      }

      return null;
    }
    case 'string':
      return typeof value === 'string' ? null : `${pointer} must be a string, received ${describeValueType(value)}`;
    case 'number':
      return typeof value === 'number' ? null : `${pointer} must be a number, received ${describeValueType(value)}`;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? null
        : `${pointer} must be an integer, received ${describeValueType(value)}`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${pointer} must be a boolean, received ${describeValueType(value)}`;
    default:
      return null;
  }
}

export class ProcessCLIAdapter extends BaseCLIAdapter {
  private readonly config: EngineCommandConfig;
  private cachedStatus?: AdapterStatus;
  private readonly strategy: CLIExecutionStrategy;

  constructor(
    slot: EngineSlot,
    name: string,
    config: EngineCommandConfig = {},
    private readonly dryRun = false,
  ) {
    super(slot, name);
    this.config = config;
    this.strategy = createCLIExecutionStrategy(slot, this.config);
  }

  async checkAvailability(): Promise<AdapterStatus> {
    if (this.cachedStatus) {
      return this.cachedStatus;
    }

    const detection = detectEngine(this.slot, this.config);

    this.cachedStatus = detection.available
      ? { available: true, command: detection.command }
      : { available: false, reason: `No executable found for ${this.name}. ${detection.reason || ''}`.trim() };

    return this.cachedStatus;
  }

  async executeText(prompt: string, options: CLIExecutionOptions = {}): Promise<CLIExecutionResult<string>> {
    if (this.dryRun) {
      return {
        stdout: `[dry-run:${this.slot}] ${prompt.slice(0, 180)}`,
        stderr: '',
        exitCode: 0,
        durationMs: 0,
      };
    }

    return this.executeInternal(prompt, options);
  }

  async executeJson<T>(prompt: string, schema: JsonSchema, options: CLIExecutionOptions = {}): Promise<CLIExecutionResult<T>> {
    if (this.dryRun) {
      const parsed = buildMockValue(schema) as T;
      return {
        stdout: JSON.stringify(parsed, null, 2),
        stderr: '',
        exitCode: 0,
        durationMs: 0,
        parsed,
      };
    }

    const normalizedSchema = normalizeJsonSchema(schema);
    const jsonPrompt =
      this.slot === 'claude'
        ? [
            prompt,
            'Return a single valid JSON object only. Do not wrap it in markdown.',
            `JSON schema:\n${JSON.stringify(normalizedSchema, null, 2)}`,
          ].join('\n\n')
        : prompt;

    const result = await this.executeInternal(jsonPrompt, {
      ...options,
      schema: this.slot === 'claude' ? undefined : normalizedSchema,
    });
    let parsed: T | undefined;
    let parseFailure: string | null = null;

    if (result.stdout.trim()) {
      try {
        const rawParsed = extractJsonBlock<Record<string, unknown>>(result.stdout);
        const candidate = this.unwrapStructuredJson<T>(rawParsed);
        const validationError = validateSchemaValue(candidate, normalizedSchema);

        if (validationError) {
          parseFailure = validationError;
        } else {
          parsed = candidate;
        }
      } catch (error) {
        parseFailure = error instanceof Error ? error.message : String(error);
      }
    }

    if (parsed !== undefined) {
      return {
        ...result,
        parsed,
      };
    }

    if (result.exitCode !== 0) {
      throw new Error(
        [result.stderr, parseFailure].filter(Boolean).join('\n') || `${this.name} exited with code ${result.exitCode}.`,
      );
    }

    const preview = result.stdout.slice(0, 240) || result.stderr.slice(0, 240) || 'No output captured.';
    throw new Error(`${this.name} returned invalid JSON output: ${parseFailure || preview}`);
  }

  private async executeInternal(prompt: string, options: CLIExecutionOptions): Promise<CLIExecutionResult<string>> {
    const status = await this.checkAvailability();
    if (!status.available || !status.command) {
      throw new Error(status.reason || `${this.name} is unavailable`);
    }

    const tempDir = ensureTempDir();
    if (options.signal?.aborted) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw createAbortError(this.name, options.signal.reason);
    }
    const outputFile = path.join(tempDir, 'last-message.txt');
    const schemaFile = options.schema ? path.join(tempDir, 'schema.json') : null;

    if (schemaFile && options.schema) {
      fs.writeFileSync(schemaFile, JSON.stringify(options.schema, null, 2), 'utf-8');
    }

    const interactiveSession = options.interactiveSession === true;
    const useStructuredStream = !schemaFile && this.strategy.shouldUseStructuredStream(options);
    const args = this.strategy.buildArgs({
      prompt,
      outputFile,
      schemaFile: schemaFile || undefined,
      allowEdits: options.allowEdits === true,
      interactiveSession,
      useStructuredStream,
    });

    if (interactiveSession) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw new Error(`${this.name} requires an interactive TTY session for manual approvals.`);
      }

      return this.executeInteractive(status.command, args, outputFile, tempDir, options.cwd || process.cwd());
    }

    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const spawnSpec = this.strategy.buildSpawnSpec(status.command!, args, tempDir);
      const detached = process.platform !== 'win32';
      const child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: options.cwd || process.cwd(),
        env: spawnSpec.env || process.env,
        // Some CLIs defer execution until stdin reaches EOF when launched non-interactively.
        // We never stream prompt input through stdin here, so close it immediately.
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
      });
      const timeoutMs = options.timeoutMs ?? 8 * 60 * 1000;
      const structuredParser = useStructuredStream ? this.strategy.createStructuredParser(options) : null;

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let closed = false;
      let lastTerminationSignal: ManagedSignal | null = null;
      let escalationTimer: ReturnType<typeof setTimeout> | null = null;
      let fatalStderrSignal: string | null = null;
      let aborted = false;
      let abortReason: unknown;
      const abortSignal = options.signal;
      let abortListener: (() => void) | null = null;

      const clearEscalationTimer = () => {
        if (escalationTimer) {
          clearTimeout(escalationTimer);
          escalationTimer = null;
        }
      };

      const clearAbortListener = () => {
        if (abortSignal && abortListener) {
          abortSignal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
      };

      const terminateChild = (signal: ManagedSignal, reason: string) => {
        if (closed) {
          return;
        }

        if (lastTerminationSignal === 'SIGKILL' || lastTerminationSignal === signal) {
          return;
        }

        if (lastTerminationSignal && signal !== 'SIGKILL') {
          return;
        }

        lastTerminationSignal = signal;
        emitSubprocessDebug(`${this.name} pid=${child.pid ?? 'unknown'} sending ${signal} (${reason}).`);

        if (signal !== 'SIGKILL' && !escalationTimer) {
          escalationTimer = setTimeout(() => {
            escalateIfNeeded();
          }, 4_000);
        }

        if (detached && typeof child.pid === 'number') {
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            emitSubprocessDebug(
              `${this.name} pid=${child.pid} process-group ${signal} failed: ${formatSubprocessError(error)}`,
            );
          }
        }

        try {
          child.kill(signal);
        } catch (error) {
          emitSubprocessDebug(`${this.name} pid=${child.pid ?? 'unknown'} kill failed: ${formatSubprocessError(error)}`);
        }
      };

      const escalateIfNeeded = () => {
        if (closed || lastTerminationSignal === 'SIGKILL') {
          return;
        }

        clearEscalationTimer();
        terminateChild('SIGKILL', 'grace period exceeded');
      };

      const unregisterChild = registerActiveChildProcess({
        pid: child.pid,
        description: `${this.name} non-interactive CLI process`,
        terminate: terminateChild,
      });

      emitSubprocessDebug(
        `${this.name} pid=${child.pid ?? 'unknown'} spawned in non-interactive mode via ${spawnSpec.command} `
        + `(${spawnSpec.args.length} arg(s), detached=${detached}).`,
      );

      const handleAbort = () => {
        if (aborted || closed) {
          return;
        }

        aborted = true;
        abortReason = abortSignal?.reason;
        terminateChild('SIGTERM', typeof abortReason === 'string' ? abortReason : 'abort requested');
      };

      if (abortSignal) {
        abortListener = () => handleAbort();
        abortSignal.addEventListener('abort', abortListener, { once: true });
        if (abortSignal.aborted) {
          handleAbort();
        }
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        terminateChild('SIGTERM', `timeout after ${timeoutMs}ms`);
      }, timeoutMs);

      child.stdout.on('data', chunk => {
        const text = chunk.toString();
        stdout += text;
        if (structuredParser) {
          structuredParser.pushStdout(text);
          return;
        }
        options.onStdoutChunk?.(stripAnsi(text));
      });

      child.stderr.on('data', chunk => {
        const text = chunk.toString();
        stderr += text;
        if (!fatalStderrSignal) {
          const detectedSignal = detectFatalStderrSignal(this.slot, stderr);
          if (detectedSignal) {
            fatalStderrSignal = detectedSignal;
            terminateChild('SIGTERM', detectedSignal);
          }
        }
        options.onStderrChunk?.(stripAnsi(text));
      });

      child.on('error', error => {
        if (closed) {
          return;
        }

        closed = true;
        clearTimeout(timeout);
        clearEscalationTimer();
        clearAbortListener();
        unregisterChild();
        emitSubprocessDebug(
          `${this.name} pid=${child.pid ?? 'unknown'} emitted error after ${Date.now() - startedAt}ms: ${formatSubprocessError(error)}`,
        );
        fs.rmSync(tempDir, { recursive: true, force: true });
        reject(aborted ? createAbortError(this.name, abortReason) : error);
      });

      child.on('close', exitCode => {
        if (closed) {
          return;
        }

        closed = true;
        clearTimeout(timeout);
        clearEscalationTimer();
        clearAbortListener();
        unregisterChild();
        const durationMs = Date.now() - startedAt;
        if (structuredParser) {
          structuredParser.flush();
        }
        const fileOutput = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8') : '';
        const streamSnapshot = structuredParser?.snapshot();
        const finalOutput = fileOutput || streamSnapshot?.lastMessage || stdout;
        const streamDiagnostics = streamSnapshot?.diagnostics.join('\n').trim() || '';

        fs.rmSync(tempDir, { recursive: true, force: true });
        emitSubprocessDebug(
          `${this.name} pid=${child.pid ?? 'unknown'} exited with code ${exitCode ?? 1} `
          + `after ${durationMs}ms${timedOut ? ' (timeout)' : aborted ? ' (aborted)' : ''}.`,
        );

        if (aborted) {
          reject(createAbortError(this.name, abortReason));
          return;
        }

        resolve({
          stdout: stripAnsi(finalOutput.trim() || stdout.trim()),
          stderr: stripAnsi(
            [
              stderr.trim(),
              streamDiagnostics,
              fatalStderrSignal || '',
              timedOut ? `${this.name} timed out after ${timeoutMs}ms.` : '',
            ].filter(Boolean).join('\n').trim(),
          ),
          exitCode: timedOut ? 124 : exitCode ?? 1,
          durationMs,
        });
      });
    });
  }

  private async executeInteractive(
    command: string,
    args: string[],
    outputFile: string,
    tempDir: string,
    cwd: string,
  ): Promise<CLIExecutionResult<string>> {
    const startedAt = Date.now();
    const stdin = process.stdin;
    const stdout = process.stdout;
    const priorRawMode = stdin.isTTY ? stdin.isRaw === true : false;
    const baseCols = stdout.columns || 120;
    const baseRows = stdout.rows || 40;
    let transcript = '';

    const child =
      (() => {
        const spawnSpec = this.strategy.buildSpawnSpec(command, args, tempDir);
        return nodePty.spawn(spawnSpec.command, spawnSpec.args, {
          name: 'xterm-color',
          cols: baseCols,
          rows: baseRows,
          cwd,
          env: spawnSpec.env || process.env,
        });
      })();

    emitSubprocessDebug(
      `${this.name} pid=${child.pid} spawned in interactive mode via PTY (${args.length} arg(s)).`,
    );

    return new Promise((resolve, reject) => {
      let cleanedUp = false;
      let lastTerminationSignal: ManagedSignal | null = null;
      let escalationTimer: ReturnType<typeof setTimeout> | null = null;
      let dataDisposable: nodePty.IDisposable | undefined;
      let exitDisposable: nodePty.IDisposable | undefined;

      const clearEscalationTimer = () => {
        if (escalationTimer) {
          clearTimeout(escalationTimer);
          escalationTimer = null;
        }
      };

      const terminateChild = (signal: ManagedSignal, reason: string) => {
        if (cleanedUp) {
          return;
        }

        if (lastTerminationSignal === 'SIGKILL' || lastTerminationSignal === signal) {
          return;
        }

        if (lastTerminationSignal && signal !== 'SIGKILL') {
          return;
        }

        lastTerminationSignal = signal;
        emitSubprocessDebug(`${this.name} pid=${child.pid} sending ${signal} (${reason}).`);

        if (signal !== 'SIGKILL' && !escalationTimer) {
          escalationTimer = setTimeout(() => {
            if (!cleanedUp) {
              clearEscalationTimer();
              terminateChild('SIGKILL', 'grace period exceeded');
            }
          }, 4_000);
        }

        try {
          child.kill(signal);
        } catch (error) {
          emitSubprocessDebug(`${this.name} pid=${child.pid} kill failed: ${formatSubprocessError(error)}`);
        }
      };

      const unregisterChild = registerActiveChildProcess({
        pid: child.pid,
        description: `${this.name} interactive PTY process`,
        terminate: terminateChild,
      });

      const resizeHandler = () => {
        child.resize(stdout.columns || baseCols, stdout.rows || baseRows);
      };

      const inputHandler = (chunk: Buffer | string) => {
        child.write(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      };

      const restoreTerminal = () => {
        if (cleanedUp) {
          return;
        }

        cleanedUp = true;
        clearEscalationTimer();
        unregisterChild();
        dataDisposable?.dispose();
        exitDisposable?.dispose();
        stdout.removeListener('resize', resizeHandler);
        stdin.removeListener('data', inputHandler);

        if (stdin.isTTY) {
          stdin.setRawMode(priorRawMode);
        }

        stdin.pause();
      };

      const finalize = (exitCode: number) => {
        restoreTerminal();
        const durationMs = Date.now() - startedAt;
        const finalOutput = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8') : transcript;
        fs.rmSync(tempDir, { recursive: true, force: true });
        emitSubprocessDebug(`${this.name} pid=${child.pid} exited with code ${exitCode} after ${durationMs}ms.`);

        resolve({
          stdout: stripAnsi(finalOutput.trim() || transcript.trim()),
          stderr: exitCode === 0 ? '' : stripAnsi(transcript.trim()),
          exitCode,
          durationMs,
        });
      };

      const fail = (error: Error) => {
        restoreTerminal();
        fs.rmSync(tempDir, { recursive: true, force: true });
        emitSubprocessDebug(`${this.name} pid=${child.pid} failed after ${Date.now() - startedAt}ms: ${error.message}`);
        reject(error);
      };

      dataDisposable = child.onData(data => {
        transcript += data;
        stdout.write(data);
      });

      exitDisposable = child.onExit(({ exitCode }) => {
        finalize(exitCode);
      });

      stdout.on('resize', resizeHandler);
      stdin.on('data', inputHandler);
      stdin.resume();

      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }

      try {
        child.resize(baseCols, baseRows);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private unwrapStructuredJson<T>(rawParsed: Record<string, unknown>): T {
    if (rawParsed && typeof rawParsed === 'object' && 'structured_output' in rawParsed) {
      return rawParsed.structured_output as T;
    }

    if (rawParsed && typeof rawParsed === 'object' && typeof rawParsed.response === 'string') {
      return this.unwrapStructuredJson<T>(extractJsonBlock<Record<string, unknown>>(rawParsed.response));
    }

    if (rawParsed && typeof rawParsed === 'object' && typeof rawParsed.result === 'string') {
      return this.unwrapStructuredJson<T>(extractJsonBlock<Record<string, unknown>>(rawParsed.result));
    }

    return rawParsed as T;
  }
}
