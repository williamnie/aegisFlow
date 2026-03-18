import fs from 'fs';
import path from 'path';

import { getSessionRootDir } from '../paths';
import { SessionState } from '../types';
import { nowIso, readJsonFile } from '../utils';

const WORKSPACE_DOC_NAME_MAP: Record<string, string> = {
  'prd-final.md': 'prd.md',
  'tech-design-final.md': 'design.md',
  'reviewprd-report.md': 'prd-review.md',
  'reviewprd-revised.md': 'prd-revised.md',
  'reviewd-report.md': 'design-review.md',
  'reviewd-revised.md': 'design-revised.md',
};

const LEGACY_SESSION_ROOT_ARTIFACTS = new Set([
  'decision-log.md',
  'delivery-summary.md',
  'final-handoff.md',
  'implementation-plan.md',
  'integration-review.md',
  'manual-review-handoff.md',
  'prd-final.md',
  'roundtable-minutes.md',
  'tech-design-final.md',
  'tech-design-review-packet.md',
]);

export interface SessionSummary {
  sessionId: string;
  sessionDir: string;
  workspace: string;
  projectLabel: string;
  createdAt: string;
  currentStage?: string;
  currentStatus?: 'pending' | 'running' | 'completed' | 'failed';
}

export class ArtifactStore {
  private readonly workspaceDir: string;
  private readonly sessionDir: string;

  constructor(sessionId?: string) {
    this.workspaceDir = process.cwd();
    const baseDir = getSessionRootDir();
    const id = sessionId || ArtifactStore.buildDefaultSessionId(this.workspaceDir, baseDir);
    this.sessionDir = path.join(baseDir, id);
    const legacySessionDir = path.join(this.workspaceDir, '.aegis', 'sessions', id);

    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    if (!fs.existsSync(this.sessionDir) && fs.existsSync(legacySessionDir)) {
      fs.cpSync(legacySessionDir, this.sessionDir, { recursive: true });
    }
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }

    if (!this.exists('session-state.json')) {
      this.saveJson('session-state.json', {
        sessionId: id,
        createdAt: nowIso(),
        workspace: process.cwd(),
        stages: {},
      } satisfies SessionState);
    }
  }

  public static buildDefaultSessionId(workspaceDir = process.cwd(), baseDir = getSessionRootDir()): string {
    const timestamp = nowIso().replace(/[:.]/g, '-');
    const workspaceSlug = this.buildWorkspaceSlug(workspaceDir);
    const baseId = workspaceSlug ? `${workspaceSlug}-${timestamp}` : timestamp;

    return this.ensureUniqueSessionId(baseId, baseDir);
  }

  public static listSessions(baseDir = getSessionRootDir()): SessionSummary[] {
    if (!fs.existsSync(baseDir)) {
      return [];
    }

    return fs.readdirSync(baseDir)
      .map(entry => path.join(baseDir, entry))
      .filter(sessionDir => fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory())
      .map(sessionDir => this.readSessionSummary(sessionDir))
      .sort((left, right) => this.toTimestamp(right.createdAt) - this.toTimestamp(left.createdAt));
  }

  public getSessionId(): string {
    return path.basename(this.sessionDir);
  }

  public getSessionDir(): string {
    return this.sessionDir;
  }

  public getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  public getArtifactPath(filename: string): string {
    return this.resolveArtifactPath(filename, 'read');
  }

  public exists(filename: string): boolean {
    return fs.existsSync(this.resolveArtifactPath(filename, 'read'));
  }

  public saveArtifact(filename: string, content: string | object): void {
    const filePath = this.resolveArtifactPath(filename, 'write');
    const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, data, 'utf-8');
  }

  public appendArtifact(filename: string, content: string): void {
    const filePath = this.resolveArtifactPath(filename, 'write');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(filePath, content, 'utf-8');
  }

  public saveJson(filename: string, content: unknown): void {
    this.saveArtifact(filename, JSON.stringify(content, null, 2));
  }

  public deleteArtifact(filename: string): boolean {
    const candidates = this.getArtifactPathCandidates(filename);
    let deleted = false;

    for (const filePath of candidates) {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        continue;
      }

      fs.unlinkSync(filePath);
      this.pruneEmptyDirs(path.dirname(filePath));
      deleted = true;
    }

    return deleted;
  }

  public deleteArtifactsByPrefix(prefix: string): string[] {
    const normalizedPrefix = this.normalizeFilename(prefix);
    const deleted: string[] = [];

    for (const artifact of this.listArtifacts()) {
      if (!artifact.startsWith(normalizedPrefix)) {
        continue;
      }

      if (this.deleteArtifact(artifact)) {
        deleted.push(artifact);
      }
    }

    return deleted;
  }

  public readArtifact(filename: string): string | null {
    const filePath = this.resolveArtifactPath(filename, 'read');
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf-8');
  }

  public readJson<T>(filename: string): T | null {
    return readJsonFile<T>(this.resolveArtifactPath(filename, 'read'));
  }

  public markStage(stage: string, status: 'pending' | 'running' | 'completed' | 'failed', note?: string): void {
    const state = this.readJson<SessionState>('session-state.json') || {
      sessionId: this.getSessionId(),
      createdAt: nowIso(),
      workspace: process.cwd(),
      stages: {},
    };

    state.currentStage = stage;
    state.stages[stage] = {
      status,
      updatedAt: nowIso(),
      ...(note ? { note } : {}),
    };

    this.saveJson('session-state.json', state);
  }

  public clearStages(stages: string[]): void {
    if (stages.length === 0) {
      return;
    }

    const state = this.readJson<SessionState>('session-state.json');
    if (!state) {
      return;
    }

    let changed = false;
    for (const stage of stages) {
      if (state.stages[stage]) {
        delete state.stages[stage];
        changed = true;
      }
      if (state.currentStage === stage) {
        delete state.currentStage;
        changed = true;
      }
    }

    if (changed) {
      this.saveJson('session-state.json', state);
    }
  }

  public listArtifacts(): string[] {
    if (!fs.existsSync(this.sessionDir)) {
      return [];
    }

    const results: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
          continue;
        }
        results.push(path.relative(this.sessionDir, fullPath));
      }
    };

    walk(this.sessionDir);
    return results.sort();
  }

  private resolveArtifactPath(filename: string, mode: 'read' | 'write'): string {
    const normalized = this.normalizeFilename(filename);
    const preferredPath = this.getPreferredArtifactPath(normalized);
    const legacyPath = this.getLegacyArtifactPath(normalized);

    if (mode === 'write') {
      if (this.isWorkspaceDocument(normalized)) {
        return preferredPath;
      }
      if (fs.existsSync(preferredPath)) {
        return preferredPath;
      }
      if (preferredPath !== legacyPath && fs.existsSync(legacyPath)) {
        return legacyPath;
      }
      return preferredPath;
    }

    if (fs.existsSync(preferredPath)) {
      return preferredPath;
    }
    if (preferredPath !== legacyPath && fs.existsSync(legacyPath)) {
      return legacyPath;
    }
    return preferredPath;
  }

  private getArtifactPathCandidates(filename: string): string[] {
    const normalized = this.normalizeFilename(filename);
    return uniquePaths([
      this.getPreferredArtifactPath(normalized),
      this.getLegacyArtifactPath(normalized),
    ]);
  }

  private getPreferredArtifactPath(filename: string): string {
    const normalized = this.normalizeFilename(filename);

    if (normalized.startsWith('archive/')) {
      return path.join(this.sessionDir, normalized);
    }

    if (this.isWorkspaceDocument(normalized)) {
      return path.join(this.workspaceDir, this.getWorkspaceDocumentPath(normalized));
    }

    return path.join(this.sessionDir, 'archive', normalized);
  }

  private getLegacyArtifactPath(filename: string): string {
    const normalized = this.normalizeFilename(filename);
    if (normalized.startsWith('archive/') || LEGACY_SESSION_ROOT_ARTIFACTS.has(normalized)) {
      return path.join(this.sessionDir, normalized);
    }

    return path.join(this.sessionDir, 'archive', normalized);
  }

  private normalizeFilename(filename: string): string {
    return filename.replace(/\\/g, '/');
  }

  private pruneEmptyDirs(dir: string): void {
    const workspaceBoundary = path.resolve(this.workspaceDir);
    const sessionBoundary = path.resolve(this.sessionDir);
    let current = path.resolve(dir);

    while (current !== workspaceBoundary && current !== sessionBoundary) {
      if (!fs.existsSync(current) || !fs.statSync(current).isDirectory()) {
        break;
      }

      if (fs.readdirSync(current).length > 0) {
        break;
      }

      fs.rmdirSync(current);
      current = path.dirname(current);
    }
  }

  private isWorkspaceDocument(filename: string): boolean {
    return Object.prototype.hasOwnProperty.call(WORKSPACE_DOC_NAME_MAP, filename);
  }

  private getWorkspaceDocumentPath(filename: string): string {
    if (filename.startsWith('task-runs/')) {
      return filename;
    }

    return WORKSPACE_DOC_NAME_MAP[filename] || path.basename(filename);
  }

  private static ensureUniqueSessionId(baseId: string, baseDir: string): string {
    if (!fs.existsSync(path.join(baseDir, baseId))) {
      return baseId;
    }

    let suffix = 2;
    let candidate = `${baseId}-${suffix}`;
    while (fs.existsSync(path.join(baseDir, candidate))) {
      suffix += 1;
      candidate = `${baseId}-${suffix}`;
    }

    return candidate;
  }

  private static readSessionSummary(sessionDir: string): SessionSummary {
    const sessionId = path.basename(sessionDir);
    const statePath = path.join(sessionDir, 'archive', 'session-state.json');
    const state = readJsonFile<SessionState>(statePath);
    const stat = fs.statSync(sessionDir);
    const currentStage = state?.currentStage;
    const currentStatus = currentStage ? state?.stages[currentStage]?.status : undefined;
    const workspace = state?.workspace || '';
    const createdAt = state?.createdAt || stat.mtime.toISOString();

    return {
      sessionId,
      sessionDir,
      workspace,
      projectLabel: workspace ? this.buildProjectLabel(workspace) : sessionId,
      createdAt,
      ...(currentStage ? { currentStage } : {}),
      ...(currentStatus ? { currentStatus } : {}),
    };
  }

  private static buildWorkspaceSlug(workspaceDir: string): string {
    const segments = this.getWorkspaceSegments(workspaceDir);
    const slug = segments
      .map(segment => this.slugifySegment(segment))
      .filter(Boolean)
      .join('-');

    return slug || 'session';
  }

  private static buildProjectLabel(workspaceDir: string): string {
    const segments = this.getWorkspaceSegments(workspaceDir);
    return segments.length > 0 ? segments.join('/') : workspaceDir;
  }

  private static getWorkspaceSegments(workspaceDir: string): string[] {
    const normalized = path.resolve(workspaceDir).split(path.sep).filter(Boolean);
    return normalized.slice(-2);
  }

  private static slugifySegment(value: string): string {
    return value
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
  }

  private static toTimestamp(value: string): number {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
