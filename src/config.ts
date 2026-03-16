import fs from 'fs';

import {
  AegisConfig,
  AegisConfigFile,
  EngineDetectionStatus,
  EngineSlot,
  ReplyLanguageConfig,
  RoutingStagePreferenceKey,
  SetupConfig,
  TaskDomain,
} from './types';
import { DEFAULT_ENGINE_CANDIDATES } from './engine-discovery';
import { ensureAegisHomeDir, getAegisConfigPath, getLegacyWorkspaceConfigPath } from './paths';
import { parseDelimitedList } from './utils';

export const CONFIG_FILENAME = 'config.json';

export const DEFAULT_REPLY_LANGUAGE: ReplyLanguageConfig = {
  code: 'zh-CN',
  label: '简体中文',
};

export const DEFAULT_DOMAIN_OWNERS: Record<TaskDomain, EngineSlot> = {
  frontend: 'gemini',
  backend: 'codex',
  architecture: 'claude',
  integration: 'claude',
  testing: 'codex',
  data: 'codex',
  docs: 'claude',
  ops: 'codex',
};

export const STAGE_PREFERENCE_KEYS: RoutingStagePreferenceKey[] = [
  'default',
  'idea',
  'prd',
  'techDesign',
  'roundtablePlan',
  'roundtableMinutes',
  'finalDesign',
  'taskPlan',
  'integrationReview',
];

function parseEngineSlot(value: string | undefined): EngineSlot | undefined {
  if (value === 'claude' || value === 'codex' || value === 'gemini') {
    return value;
  }

  return undefined;
}

function parseEngineSlotList(value: unknown): EngineSlot[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(item => parseEngineSlot(String(item))).filter(Boolean) as EngineSlot[];
}

function normalizeLanguage(value: unknown): ReplyLanguageConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_REPLY_LANGUAGE;
  }

  const candidate = value as Partial<ReplyLanguageConfig>;
  const code = typeof candidate.code === 'string' && candidate.code.trim() ? candidate.code.trim() : DEFAULT_REPLY_LANGUAGE.code;
  const label = typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : code;
  return { code, label };
}

function normalizeDetectedEngine(value: unknown): EngineDetectionStatus | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Partial<EngineDetectionStatus>;
  return {
    available: candidate.available === true,
    command: typeof candidate.command === 'string' ? candidate.command : undefined,
    reason: typeof candidate.reason === 'string' ? candidate.reason : undefined,
    candidates: Array.isArray(candidate.candidates)
      ? candidate.candidates.map(item => String(item).trim()).filter(Boolean)
      : [],
  };
}

function normalizeSetup(value: unknown): SetupConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      completed: false,
      detectedEngines: {},
    };
  }

  const candidate = value as Partial<SetupConfig>;
  const detectedEngines = {
    claude: normalizeDetectedEngine(candidate.detectedEngines?.claude),
    codex: normalizeDetectedEngine(candidate.detectedEngines?.codex),
    gemini: normalizeDetectedEngine(candidate.detectedEngines?.gemini),
  };

  return {
    completed: candidate.completed === true,
    mode: candidate.mode === 'default' || candidate.mode === 'custom' ? candidate.mode : undefined,
    initializedAt: typeof candidate.initializedAt === 'string' ? candidate.initializedAt : undefined,
    detectedEngines,
  };
}

export function readAegisConfigFile(cwd = process.cwd()): AegisConfigFile {
  const filePath = getAegisConfigPath();
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AegisConfigFile;
  }

  const legacyPath = getLegacyWorkspaceConfigPath(cwd);
  if (!fs.existsSync(legacyPath)) {
    return {};
  }

  const legacyConfig = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as AegisConfigFile;
  writeAegisConfigFile(legacyConfig);
  return legacyConfig;
}

function writeAegisConfigFile(config: AegisConfigFile): string {
  ensureAegisHomeDir();
  const filePath = getAegisConfigPath();
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return filePath;
}

export function writeAegisConfig(config: AegisConfig): string {
  return writeAegisConfigFile(compactAegisConfig(config));
}

export function createAegisConfig(fileConfig: AegisConfigFile = {}): AegisConfig {
  const fallbackOrder =
    (fileConfig.routing?.fallbackOrder || [])
      .map(slot => parseEngineSlot(slot))
      .filter(Boolean) as EngineSlot[];

  const domainOwners = { ...DEFAULT_DOMAIN_OWNERS, ...(fileConfig.routing?.domainOwners || {}) };
  const stagePreferences = Object.fromEntries(
    STAGE_PREFERENCE_KEYS.map(key => [key, parseEngineSlotList(fileConfig.routing?.stagePreferences?.[key])]).filter(
      ([, value]) => value.length > 0,
    ),
  ) as Partial<Record<RoutingStagePreferenceKey, EngineSlot[]>>;

  return {
    dryRun: fileConfig.dryRun === true,
    setup: normalizeSetup(fileConfig.setup),
    language: normalizeLanguage(fileConfig.language),
    routing: {
      designLead: parseEngineSlot(fileConfig.routing?.designLead),
      fallbackOrder: fallbackOrder.length > 0 ? fallbackOrder : ['claude', 'codex', 'gemini'],
      domainOwners,
      stagePreferences,
    },
    engines: {
      codex: {
        candidates: DEFAULT_ENGINE_CANDIDATES.codex,
        ...(fileConfig.engines?.codex || {}),
      },
      claude: {
        candidates: DEFAULT_ENGINE_CANDIDATES.claude,
        ...(fileConfig.engines?.claude || {}),
      },
      gemini: {
        candidates: DEFAULT_ENGINE_CANDIDATES.gemini,
        ...(fileConfig.engines?.gemini || {}),
      },
    },
  };
}

function slotListsEqual(left: EngineSlot[] = [], right: EngineSlot[] = []): boolean {
  return left.length === right.length && left.every((slot, index) => slot === right[index]);
}

function compactDomainOwners(domainOwners: Record<TaskDomain, EngineSlot>): Partial<Record<TaskDomain, EngineSlot>> {
  return Object.fromEntries(
    Object.entries(domainOwners).filter(([domain, owner]) => DEFAULT_DOMAIN_OWNERS[domain as TaskDomain] !== owner),
  ) as Partial<Record<TaskDomain, EngineSlot>>;
}

function compactStagePreferences(
  stagePreferences: Partial<Record<RoutingStagePreferenceKey, EngineSlot[]>>,
  fallbackOrder: EngineSlot[],
): Partial<Record<RoutingStagePreferenceKey, EngineSlot[]>> {
  const compact: Partial<Record<RoutingStagePreferenceKey, EngineSlot[]>> = {};
  const defaultPreference = stagePreferences.default;

  if (defaultPreference && defaultPreference.length > 0 && !slotListsEqual(defaultPreference, fallbackOrder)) {
    compact.default = defaultPreference;
  }

  for (const key of STAGE_PREFERENCE_KEYS) {
    if (key === 'default') {
      continue;
    }

    const preference = stagePreferences[key];
    if (!preference || preference.length === 0) {
      continue;
    }

    const baseline = defaultPreference && defaultPreference.length > 0 ? defaultPreference : fallbackOrder;
    if (!slotListsEqual(preference, baseline)) {
      compact[key] = preference;
    }
  }

  return compact;
}

function compactEngines(engines: AegisConfig['engines']): AegisConfigFile['engines'] {
  const compactEntries = (Object.keys(DEFAULT_ENGINE_CANDIDATES) as EngineSlot[])
    .map(slot => {
      const config = engines[slot];
      if (!config) {
        return null;
      }

      const compactConfig = {
        ...(config.command && !DEFAULT_ENGINE_CANDIDATES[slot].includes(config.command) ? { command: config.command } : {}),
        ...(config.args && config.args.length > 0 ? { args: config.args } : {}),
        ...(config.candidates && config.candidates.some(candidate => !DEFAULT_ENGINE_CANDIDATES[slot].includes(candidate))
          ? { candidates: config.candidates.filter(candidate => !DEFAULT_ENGINE_CANDIDATES[slot].includes(candidate)) }
          : {}),
      };

      return Object.keys(compactConfig).length > 0 ? [slot, compactConfig] : null;
    })
    .filter(Boolean) as Array<[EngineSlot, { command?: string; args?: string[]; candidates?: string[] }]>;

  return compactEntries.length > 0 ? Object.fromEntries(compactEntries) : undefined;
}

function compactAegisConfig(config: AegisConfig): AegisConfigFile {
  const domainOwners = compactDomainOwners(config.routing.domainOwners);
  const stagePreferences = compactStagePreferences(config.routing.stagePreferences, config.routing.fallbackOrder);
  const engines = compactEngines(config.engines);

  return {
    dryRun: config.dryRun,
    setup: config.setup,
    language: config.language,
    routing: {
      ...(config.routing.designLead ? { designLead: config.routing.designLead } : {}),
      fallbackOrder: config.routing.fallbackOrder,
      ...(Object.keys(domainOwners).length > 0 ? { domainOwners } : {}),
      ...(Object.keys(stagePreferences).length > 0 ? { stagePreferences } : {}),
    },
    ...(engines ? { engines } : {}),
  };
}

export function loadAegisConfig(cwd = process.cwd()): AegisConfig {
  const fileConfig = createAegisConfig(readAegisConfigFile(cwd));
  const envFallback =
    parseDelimitedList(process.env.AEGISFLOW_FALLBACK_ORDER)?.map(slot => parseEngineSlot(slot)).filter(Boolean) as
      | EngineSlot[]
      | undefined;
  const envLanguage = typeof process.env.AEGISFLOW_LANGUAGE === 'string' && process.env.AEGISFLOW_LANGUAGE.trim()
    ? process.env.AEGISFLOW_LANGUAGE.trim()
    : undefined;

  return {
    ...fileConfig,
    dryRun: process.env.AEGISFLOW_DRY_RUN === '1' || fileConfig.dryRun === true,
    language: envLanguage
      ? {
          code: envLanguage,
          label: envLanguage,
        }
      : fileConfig.language,
    routing: {
      ...fileConfig.routing,
      designLead: parseEngineSlot(process.env.AEGISFLOW_DESIGN_LEAD) || fileConfig.routing.designLead,
      fallbackOrder:
        envFallback && envFallback.length > 0
          ? envFallback
          : fileConfig.routing.fallbackOrder.length > 0
            ? fileConfig.routing.fallbackOrder
            : ['claude', 'codex', 'gemini'],
    },
    engines: {
      codex: {
        ...(fileConfig.engines.codex || {}),
        command: process.env.AEGISFLOW_CODEX_CMD || fileConfig.engines.codex?.command,
        args: parseDelimitedList(process.env.AEGISFLOW_CODEX_ARGS) || fileConfig.engines.codex?.args,
      },
      claude: {
        ...(fileConfig.engines.claude || {}),
        command: process.env.AEGISFLOW_CLAUDE_CMD || fileConfig.engines.claude?.command,
        args: parseDelimitedList(process.env.AEGISFLOW_CLAUDE_ARGS) || fileConfig.engines.claude?.args,
      },
      gemini: {
        ...(fileConfig.engines.gemini || {}),
        command: process.env.AEGISFLOW_GEMINI_CMD || fileConfig.engines.gemini?.command,
        args: parseDelimitedList(process.env.AEGISFLOW_GEMINI_ARGS) || fileConfig.engines.gemini?.args,
      },
    },
  };
}
