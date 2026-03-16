import { spawnSync } from 'child_process';

import { EngineCommandConfig, EngineDetectionStatus, EngineSlot } from './types';
import { unique } from './utils';

export const ALL_ENGINE_SLOTS: EngineSlot[] = ['claude', 'codex', 'gemini'];

export const ENGINE_LABELS: Record<EngineSlot, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

export const DEFAULT_ENGINE_CANDIDATES: Record<EngineSlot, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  gemini: ['gemini', 'gemini-cli'],
};

export function commandExists(command: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(checker, [command], { stdio: 'ignore' }).status === 0;
}

export function resolveEngineCandidates(slot: EngineSlot, config: EngineCommandConfig = {}): string[] {
  return unique([config.command, ...(config.candidates || []), ...DEFAULT_ENGINE_CANDIDATES[slot]].filter(Boolean) as string[]);
}

export function detectEngine(slot: EngineSlot, config: EngineCommandConfig = {}): EngineDetectionStatus {
  const candidates = resolveEngineCandidates(slot, config);
  const command = candidates.find(commandExists);

  if (command) {
    return {
      available: true,
      command,
      candidates,
    };
  }

  return {
    available: false,
    candidates,
    reason: `Tried: ${candidates.join(', ') || '(none)'}`,
  };
}

export function detectEngines(
  configs: Partial<Record<EngineSlot, EngineCommandConfig>> = {},
): Record<EngineSlot, EngineDetectionStatus> {
  return {
    claude: detectEngine('claude', configs.claude),
    codex: detectEngine('codex', configs.codex),
    gemini: detectEngine('gemini', configs.gemini),
  };
}
