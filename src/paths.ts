import fs from 'fs';
import os from 'os';
import path from 'path';

export const AEGIS_HOME_DIRNAME = '.aegisflow';
export const GLOBAL_CONFIG_FILENAME = 'config.json';
export const LEGACY_WORKSPACE_CONFIG_FILENAME = 'aegisflow.config.json';

export function getAegisHomeDir(): string {
  return path.join(os.homedir(), AEGIS_HOME_DIRNAME);
}

export function ensureAegisHomeDir(): string {
  const dir = getAegisHomeDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getAegisConfigPath(): string {
  return path.join(getAegisHomeDir(), GLOBAL_CONFIG_FILENAME);
}

export function getLegacyWorkspaceConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, LEGACY_WORKSPACE_CONFIG_FILENAME);
}

export function getSessionRootDir(): string {
  return path.join(getAegisHomeDir(), 'sessions');
}
