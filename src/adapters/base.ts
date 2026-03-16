import { EngineSlot, JsonSchema } from '../types';

export interface CLIExecutionResult<T = string> {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  parsed?: T;
}

export interface AdapterStatus {
  available: boolean;
  command?: string;
  reason?: string;
}

export interface CLIExecutionOptions {
  cwd?: string;
  schema?: JsonSchema;
  timeoutMs?: number;
  allowEdits?: boolean;
  interactiveSession?: boolean;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export abstract class BaseCLIAdapter {
  constructor(
    public readonly slot: EngineSlot,
    public readonly name: string,
  ) {}

  abstract checkAvailability(): Promise<AdapterStatus>;

  abstract executeText(prompt: string, options?: CLIExecutionOptions): Promise<CLIExecutionResult<string>>;

  abstract executeJson<T>(prompt: string, schema: JsonSchema, options?: CLIExecutionOptions): Promise<CLIExecutionResult<T>>;
}
