import fs from 'fs';
import path from 'path';

import { getSessionRootDir } from '../paths';
import { SessionState } from '../types';
import { nowIso, readJsonFile } from '../utils';

const WORKSPACE_DOC_NAME_MAP: Record<string, string> = {
  'prd-final.md': 'prd.md',
  'tech-design-final.md': 'design.md',
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

export class ArtifactStore {
  private readonly workspaceDir: string;
  private readonly sessionDir: string;

  constructor(sessionId?: string) {
    this.workspaceDir = process.cwd();
    const id = sessionId || new Date().toISOString().replace(/[:.]/g, '-');
    const baseDir = getSessionRootDir();
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

  private isWorkspaceDocument(filename: string): boolean {
    return Object.prototype.hasOwnProperty.call(WORKSPACE_DOC_NAME_MAP, filename);
  }

  private getWorkspaceDocumentPath(filename: string): string {
    if (filename.startsWith('task-runs/')) {
      return filename;
    }

    return WORKSPACE_DOC_NAME_MAP[filename] || path.basename(filename);
  }
}
