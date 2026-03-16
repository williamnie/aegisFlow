import * as p from '@clack/prompts';

import {
  AegisConfig,
  EngineDetectionStatus,
  EngineSlot,
  ReplyLanguageConfig,
  SetupMode,
  TaskDomain,
} from './types';
import {
  createAegisConfig,
  DEFAULT_DOMAIN_OWNERS,
  DEFAULT_REPLY_LANGUAGE,
  readAegisConfigFile,
  writeAegisConfig,
} from './config';
import { ALL_ENGINE_SLOTS, detectEngines, ENGINE_LABELS } from './engine-discovery';
import { getAegisConfigPath } from './paths';
import { nowIso, unique } from './utils';
import { ChatUI } from './ui/chat-cli';

const DOMAIN_LABELS: Record<TaskDomain, string> = {
  frontend: '前端',
  backend: '后端',
  architecture: '架构',
  integration: '集成',
  testing: '测试',
  data: '数据',
  docs: '文档',
  ops: '运维',
};

const LANGUAGE_OPTIONS: Array<{ value: string; label: string; language: ReplyLanguageConfig }> = [
  {
    value: 'zh-CN',
    label: '简体中文',
    language: { code: 'zh-CN', label: '简体中文' },
  },
  {
    value: 'en-US',
    label: 'English',
    language: { code: 'en-US', label: 'English' },
  },
  {
    value: 'custom',
    label: '自定义语言',
    language: DEFAULT_REPLY_LANGUAGE,
  },
];

function cancelIfNeeded<T>(value: T): T {
  return ChatUI.resolvePrompt(value);
}

function availableSlots(detection: Record<EngineSlot, EngineDetectionStatus>): EngineSlot[] {
  const detected = ALL_ENGINE_SLOTS.filter(slot => detection[slot]?.available);
  return detected.length > 0 ? detected : ALL_ENGINE_SLOTS;
}

function selectableSlots(detection: Record<EngineSlot, EngineDetectionStatus>, preferred?: EngineSlot): EngineSlot[] {
  return unique(preferred ? [preferred, ...availableSlots(detection)] : availableSlots(detection));
}

function pickPreferredLead(
  detection: Record<EngineSlot, EngineDetectionStatus>,
  currentLead?: EngineSlot,
): EngineSlot {
  const installed = availableSlots(detection);
  return currentLead && installed.includes(currentLead) ? currentLead : installed[0] || currentLead || 'codex';
}

function buildFallbackOrder(
  preferred: EngineSlot,
  detection: Record<EngineSlot, EngineDetectionStatus>,
): EngineSlot[] {
  return unique([preferred, ...availableSlots(detection), ...ALL_ENGINE_SLOTS]);
}

function pickDomainOwner(
  domain: TaskDomain,
  detection: Record<EngineSlot, EngineDetectionStatus>,
  lead: EngineSlot,
  currentOwner?: EngineSlot,
): EngineSlot {
  const installed = availableSlots(detection);
  const defaultOwner = DEFAULT_DOMAIN_OWNERS[domain];

  if (currentOwner && installed.includes(currentOwner)) {
    return currentOwner;
  }

  if (installed.includes(defaultOwner)) {
    return defaultOwner;
  }

  if (installed.includes(lead)) {
    return lead;
  }

  return installed[0] || lead;
}

function buildRecommendedDomainOwners(
  detection: Record<EngineSlot, EngineDetectionStatus>,
  lead: EngineSlot,
  currentOwners: Record<TaskDomain, EngineSlot>,
): Record<TaskDomain, EngineSlot> {
  return {
    frontend: pickDomainOwner('frontend', detection, lead, currentOwners.frontend),
    backend: pickDomainOwner('backend', detection, lead, currentOwners.backend),
    architecture: pickDomainOwner('architecture', detection, lead, currentOwners.architecture),
    integration: pickDomainOwner('integration', detection, lead, currentOwners.integration),
    testing: pickDomainOwner('testing', detection, lead, currentOwners.testing),
    data: pickDomainOwner('data', detection, lead, currentOwners.data),
    docs: pickDomainOwner('docs', detection, lead, currentOwners.docs),
    ops: pickDomainOwner('ops', detection, lead, currentOwners.ops),
  };
}

function buildEngineOptions(
  detection: Record<EngineSlot, EngineDetectionStatus>,
  preferred?: EngineSlot,
): Array<{ value: string; label: string }> {
  return selectableSlots(detection, preferred).map(slot => {
    const status = detection[slot];
    const suffix = status?.available ? ` (${status.command})` : ' (未检测到)';
    return {
      value: slot,
      label: `${ENGINE_LABELS[slot]}${suffix}`,
    };
  });
}

function buildEngineConfig(config: AegisConfig, detection: Record<EngineSlot, EngineDetectionStatus>): AegisConfig['engines'] {
  return {
    claude: {
      ...(config.engines.claude || {}),
      command: detection.claude.command || config.engines.claude?.command,
    },
    codex: {
      ...(config.engines.codex || {}),
      command: detection.codex.command || config.engines.codex?.command,
    },
    gemini: {
      ...(config.engines.gemini || {}),
      command: detection.gemini.command || config.engines.gemini?.command,
    },
  };
}

function renderDetectionSummary(detection: Record<EngineSlot, EngineDetectionStatus>): string {
  return ALL_ENGINE_SLOTS.map(slot => {
    const status = detection[slot];
    if (status.available) {
      return `- ${ENGINE_LABELS[slot]}: 已检测到 \`${status.command}\``;
    }

    return `- ${ENGINE_LABELS[slot]}: 未检测到 (${status.reason || 'PATH 中不可用'})`;
  }).join('\n');
}

function renderSetupSummary(config: AegisConfig, configPath: string): string {
  const overrideCount = Object.entries(config.routing.domainOwners).filter(
    ([domain, owner]) => DEFAULT_DOMAIN_OWNERS[domain as TaskDomain] !== owner,
  ).length;

  return [
    `主 Agent：${config.routing.designLead ? ENGINE_LABELS[config.routing.designLead] : '未设置'}`,
    `默认语言：${config.language.label}`,
    `自定义分工：${overrideCount > 0 ? `${overrideCount} 项` : '无'}`,
    `配置文件：${configPath}`,
  ].join('\n');
}

async function askSetupMode(): Promise<SetupMode> {
  const answer = cancelIfNeeded(
    await p.select({
      message: '请选择初始化方式：',
      options: [
        { value: 'default', label: '使用推荐配置' },
        { value: 'custom', label: '自定义主 Agent / 分工 / 语言' },
      ],
      initialValue: 'default',
    }),
  );

  return answer as SetupMode;
}

async function askLanguage(currentLanguage: ReplyLanguageConfig): Promise<ReplyLanguageConfig> {
  const selected = cancelIfNeeded(
    await p.select({
      message: '后续默认使用哪种回复语言？',
      options: LANGUAGE_OPTIONS.map(option => ({ value: option.value, label: option.label })),
      initialValue: LANGUAGE_OPTIONS.some(option => option.value === currentLanguage.code)
        ? currentLanguage.code
        : 'zh-CN',
    }),
  );

  if (selected === 'custom') {
    const customLanguage = ChatUI.resolveTextPrompt(
      await p.text({
        message: '请输入默认回复语言名称',
        placeholder: '例如：日本語 / Deutsch / 繁體中文',
        validate: value => (!value ? '请输入语言名称' : undefined),
      }),
    );

    return {
      code: customLanguage,
      label: customLanguage,
    };
  }

  return LANGUAGE_OPTIONS.find(option => option.value === selected)?.language || currentLanguage;
}

async function askPreferredEngine(
  message: string,
  detection: Record<EngineSlot, EngineDetectionStatus>,
  preferred?: EngineSlot,
): Promise<EngineSlot> {
  const answer = cancelIfNeeded(
    await p.select({
      message,
      options: buildEngineOptions(detection, preferred),
      initialValue: preferred,
    }),
  );

  return answer as EngineSlot;
}

async function askCustomizeDomainRouting(initialValue: boolean): Promise<boolean> {
  const answer = cancelIfNeeded(
    await p.confirm({
      message: '是否需要单独指定前端/后端等领域的默认 Agent？',
      initialValue,
    }),
  );

  return answer === true;
}

async function askCustomDomainOwners(
  detection: Record<EngineSlot, EngineDetectionStatus>,
  currentOwners: Record<TaskDomain, EngineSlot>,
): Promise<Record<TaskDomain, EngineSlot>> {
  const selected = { ...currentOwners };

  for (const domain of Object.keys(DOMAIN_LABELS) as TaskDomain[]) {
    selected[domain] = await askPreferredEngine(
      `${DOMAIN_LABELS[domain]}任务默认交给谁？`,
      detection,
      selected[domain],
    );
  }

  return selected;
}

export async function ensureAegisInitialized(options: { cwd?: string; force?: boolean } = {}): Promise<AegisConfig> {
  const cwd = options.cwd || process.cwd();
  const rawConfig = readAegisConfigFile(cwd);
  const baseConfig = createAegisConfig(rawConfig);

  if (baseConfig.setup.completed && !options.force) {
    return baseConfig;
  }

  const detection = detectEngines(baseConfig.engines);

  ChatUI.stage('初始化向导', [
    options.force ? '已进入重新配置模式。' : '检测到当前工作区还没有完成初始化，先完成一次启动配置。',
    `将自动探测本地可用 CLI，并把偏好保存到 ${getAegisConfigPath()}。`,
  ]);
  ChatUI.info('本地 CLI 检测', renderDetectionSummary(detection));

  const mode = await askSetupMode();
  const language = await askLanguage(baseConfig.language);
  let designLead = pickPreferredLead(detection, baseConfig.routing.designLead);
  let domainOwners = buildRecommendedDomainOwners(detection, designLead, baseConfig.routing.domainOwners);
  const hadStoredDomainOverrides = Boolean(rawConfig.routing?.domainOwners && Object.keys(rawConfig.routing.domainOwners).length > 0);

  if (mode === 'custom') {
    designLead = await askPreferredEngine('主 Agent 默认由谁负责？', detection, designLead);
    const shouldCustomizeDomainRouting = await askCustomizeDomainRouting(hadStoredDomainOverrides);
    if (shouldCustomizeDomainRouting) {
      domainOwners = await askCustomDomainOwners(
        detection,
        buildRecommendedDomainOwners(detection, designLead, domainOwners),
      );
    }
  }

  const fallbackOrder = buildFallbackOrder(designLead, detection);
  const config: AegisConfig = {
    ...baseConfig,
    language,
    setup: {
      completed: true,
      mode,
      initializedAt: nowIso(),
      detectedEngines: detection,
    },
    routing: {
      ...baseConfig.routing,
      designLead,
      fallbackOrder,
      domainOwners,
      stagePreferences: {},
    },
    engines: buildEngineConfig(baseConfig, detection),
  };

  const configPath = writeAegisConfig(config);

  ChatUI.info('初始化完成', renderSetupSummary(config, configPath));
  return config;
}
