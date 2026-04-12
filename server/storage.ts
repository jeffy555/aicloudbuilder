import {
  type User,
  type InsertUser,
  type Session,
  type InsertSession,
  type Message,
  type InsertMessage,
  type GeneratedFile,
  type InsertGeneratedFile,
  type UserActivity,
  type InsertUserActivity,
  type ArchitectureVersion,
  type InsertArchitectureVersion,
  type BuildHistory,
  type InsertBuildHistory,
} from "@shared/schema";
import { randomUUID } from "crypto";
import { dedupeGeneratedFilesKeepNewest } from "./utils/generated-files-dedupe";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  getUserByMicrosoftId(microsoftId: string): Promise<User | undefined>;
  getUserByAwsSub(awsSub: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserMicrosoftId(userId: string, microsoftId: string): Promise<User>;
  updateUserAwsSub(userId: string, awsSub: string): Promise<User>;

  // Session methods
  getSession(id: string): Promise<Session | undefined>;
  createSession(session: InsertSession): Promise<Session>;
  updateSession(id: string, updates: Partial<InsertSession>): Promise<Session>;

  // Message methods
  getMessagesBySession(sessionId: string): Promise<Message[]>;
  createMessage(message: InsertMessage): Promise<Message>;

  // Generated file methods
  getFilesBySession(sessionId: string): Promise<GeneratedFile[]>;
  createFile(file: InsertGeneratedFile): Promise<GeneratedFile>;
  updateFile(id: string, content: string): Promise<GeneratedFile>;
  deleteFile(id: string): Promise<void>;
  deleteFilesBySession(sessionId: string): Promise<void>;

  // User history methods
  getSessionsByUser(userId: string, options?: { module?: string; limit?: number; offset?: number }): Promise<Session[]>;
  getSessionCountByUser(userId: string): Promise<number>;
  createUserActivity(activity: InsertUserActivity): Promise<UserActivity>;
  getUserActivities(userId: string, options?: { module?: string; limit?: number; offset?: number }): Promise<UserActivity[]>;

  // Architecture version history methods
  createArchitectureVersion(version: InsertArchitectureVersion): Promise<ArchitectureVersion>;
  getArchitectureVersions(sessionId: string): Promise<ArchitectureVersion[]>;
  getArchitectureVersion(id: string): Promise<ArchitectureVersion | undefined>;

  // Build history methods
  createBuildHistory(build: InsertBuildHistory): Promise<BuildHistory>;
  getBuildHistory(options: { userId?: string; sessionId?: string; module?: string; limit?: number; offset?: number }): Promise<BuildHistory[]>;
  getBuildById(id: string): Promise<BuildHistory | undefined>;
  getBuildByBuildId(buildId: string): Promise<BuildHistory | undefined>;
  updateBuildHistory(id: string, updates: Partial<InsertBuildHistory>): Promise<BuildHistory>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private sessions: Map<string, Session>;
  private messages: Map<string, Message>;
  private generatedFiles: Map<string, GeneratedFile>;
  private userActivitiesMap: Map<string, UserActivity>;
  private archVersions: Map<string, ArchitectureVersion>;
  private buildHistoryMap: Map<string, BuildHistory>;

  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.messages = new Map();
    this.generatedFiles = new Map();
    this.userActivitiesMap = new Map();
    this.archVersions = new Map();
    this.buildHistoryMap = new Map();
  }

  // User methods
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.getUser(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async getUserByMicrosoftId(microsoftId: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.microsoftId === microsoftId,
    );
  }

  async updateUserMicrosoftId(userId: string, microsoftId: string): Promise<User> {
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found");
    const updated = { ...user, microsoftId, authProvider: "microsoft", updatedAt: new Date() };
    this.users.set(userId, updated);
    return updated;
  }

  async getUserByAwsSub(awsSub: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => (user as any).awsSub === awsSub,
    );
  }

  async updateUserAwsSub(userId: string, awsSub: string): Promise<User> {
    const user = this.users.get(userId);
    if (!user) throw new Error("User not found");
    const updated = { ...user, awsSub, authProvider: "aws", updatedAt: new Date() };
    this.users.set(userId, updated);
    return updated;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const now = new Date();
    const user = {
      microsoftId: null,
      awsSub: null,
      authProvider: "local",
      password: null,
      ...insertUser,
      id: id as string,
      createdAt: now,
      updatedAt: now,
    } as User;
    this.users.set(id, user);
    return user;
  }

  // Session methods
  async getSession(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async createSession(insertSession: InsertSession): Promise<Session> {
    const id = randomUUID();
    const now = new Date();
    const session: Session = {
      id,
      userId: insertSession.userId ?? null,
      provider: insertSession.provider ?? null,
      repositoryId: insertSession.repositoryId ?? null,
      repositoryName: insertSession.repositoryName ?? null,
      repositoryBranch: insertSession.repositoryBranch ?? null,
      cloudProvider: insertSession.cloudProvider ?? null,
      moduleApproach: insertSession.moduleApproach ?? null,
      activeModule: insertSession.activeModule ?? null,
      currentStep: insertSession.currentStep ?? '1',
      workflowStep: insertSession.workflowStep ?? 'landing',
      isExistingRepo: insertSession.isExistingRepo ?? null,
      detectedCloudProvider: insertSession.detectedCloudProvider ?? null,
      detectedModuleType: insertSession.detectedModuleType ?? null,
      detectedTerraformFiles: insertSession.detectedTerraformFiles ?? null,
      archMeAnalysis: (insertSession as any).archMeAnalysis ?? null,
      hasBackend: insertSession.hasBackend ?? null,
      backendType: insertSession.backendType ?? null,
      backendStorageAccount: insertSession.backendStorageAccount ?? null,
      backendResourceGroup: insertSession.backendResourceGroup ?? null,
      backendContainer: insertSession.backendContainer ?? null,
      backendStateKey: insertSession.backendStateKey ?? null,
      backendLocation: insertSession.backendLocation ?? null,
      backendValidated: insertSession.backendValidated ?? null,
      backendDeclined: insertSession.backendDeclined ?? null,
      scannedResources: insertSession.scannedResources ?? null,
      scanTimestamp: insertSession.scanTimestamp ?? null,
      selectedResourceGroups: insertSession.selectedResourceGroups ?? null,
      usageMetricsCache: insertSession.usageMetricsCache ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  async updateSession(id: string, updates: Partial<InsertSession>): Promise<Session> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error('Session not found');
    }
    const updated: Session = {
      ...session,
      ...updates,
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  // Message methods
  async getMessagesBySession(sessionId: string): Promise<Message[]> {
    return Array.from(this.messages.values())
      .filter((msg) => msg.sessionId === sessionId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = randomUUID();
    const message: Message = {
      ...insertMessage,
      id,
      createdAt: new Date(),
    };
    this.messages.set(id, message);
    return message;
  }

  // Generated file methods
  async getFilesBySession(sessionId: string): Promise<GeneratedFile[]> {
    const raw = Array.from(this.generatedFiles.values()).filter((file) => file.sessionId === sessionId);
    const { kept, removeIds } = dedupeGeneratedFilesKeepNewest(raw);
    for (const id of removeIds) {
      this.generatedFiles.delete(id);
    }
    return kept;
  }

  async createFile(insertFile: InsertGeneratedFile): Promise<GeneratedFile> {
    const id = randomUUID();
    const now = new Date();
    const file: GeneratedFile = {
      ...insertFile,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.generatedFiles.set(id, file);
    return file;
  }

  async updateFile(id: string, content: string): Promise<GeneratedFile> {
    const file = this.generatedFiles.get(id);
    if (!file) {
      throw new Error('File not found');
    }
    const updated: GeneratedFile = {
      ...file,
      content,
      updatedAt: new Date(),
    };
    this.generatedFiles.set(id, updated);
    return updated;
  }

  async deleteFile(id: string): Promise<void> {
    this.generatedFiles.delete(id);
  }

  async deleteFilesBySession(sessionId: string): Promise<void> {
    const fileIds = Array.from(this.generatedFiles.values())
      .filter((file) => file.sessionId === sessionId)
      .map((file) => file.id);

    fileIds.forEach((id) => this.generatedFiles.delete(id));
  }

  // User history methods
  async getSessionsByUser(userId: string, options?: { module?: string; limit?: number; offset?: number }): Promise<Session[]> {
    let sessions = Array.from(this.sessions.values())
      .filter((s) => s.userId === userId);

    if (options?.module) {
      sessions = sessions.filter((s) => {
        if (s.activeModule) return s.activeModule === options.module;
        // Infer module for legacy sessions
        if (options.module === 'terraform' && (s.cloudProvider || s.moduleApproach || s.backendType)) return true;
        if (options.module === 'archme' && s.archMeAnalysis) return true;
        return false;
      });
    }

    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;
    return sessions.slice(offset, offset + limit);
  }

  async getSessionCountByUser(userId: string): Promise<number> {
    return Array.from(this.sessions.values()).filter((s) => s.userId === userId).length;
  }

  async createUserActivity(activity: InsertUserActivity): Promise<UserActivity> {
    const id = randomUUID();
    const record: UserActivity = {
      id,
      userId: activity.userId,
      sessionId: activity.sessionId ?? null,
      module: activity.module,
      actionType: activity.actionType,
      actionLabel: activity.actionLabel,
      metadata: activity.metadata ?? null,
      createdAt: new Date(),
    };
    this.userActivitiesMap.set(id, record);
    return record;
  }

  async getUserActivities(userId: string, options?: { module?: string; limit?: number; offset?: number }): Promise<UserActivity[]> {
    let activities = Array.from(this.userActivitiesMap.values())
      .filter((a) => a.userId === userId);

    if (options?.module) {
      activities = activities.filter((a) => a.module === options.module);
    }

    activities.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;
    return activities.slice(offset, offset + limit);
  }

  // Architecture version history methods
  async createArchitectureVersion(insert: InsertArchitectureVersion): Promise<ArchitectureVersion> {
    const id = randomUUID();
    const version: ArchitectureVersion = {
      id,
      sessionId: insert.sessionId,
      version: insert.version,
      label: insert.label ?? null,
      analysisSnapshot: insert.analysisSnapshot,
      mermaidSyntax: insert.mermaidSyntax ?? null,
      diagramType: insert.diagramType ?? null,
      componentsSnapshot: insert.componentsSnapshot ?? null,
      codeSnapshot: insert.codeSnapshot ?? null,
      compliancePresets: insert.compliancePresets ?? null,
      createdAt: new Date(),
    };
    this.archVersions.set(id, version);
    return version;
  }

  async getArchitectureVersions(sessionId: string): Promise<ArchitectureVersion[]> {
    return Array.from(this.archVersions.values())
      .filter(v => v.sessionId === sessionId)
      .sort((a, b) => a.version - b.version);
  }

  async getArchitectureVersion(id: string): Promise<ArchitectureVersion | undefined> {
    return this.archVersions.get(id);
  }

  // Build history methods
  async createBuildHistory(insert: InsertBuildHistory): Promise<BuildHistory> {
    const id = randomUUID();
    const build: BuildHistory = {
      id,
      userId: insert.userId ?? null,
      sessionId: insert.sessionId,
      module: insert.module,
      buildId: insert.buildId,
      status: insert.status ?? 'completed',
      stages: insert.stages ?? null,
      pipelineStages: insert.pipelineStages ?? null,
      totalDurationMs: insert.totalDurationMs ?? null,
      filesGenerated: insert.filesGenerated ?? null,
      repositoryName: insert.repositoryName ?? null,
      repositoryBranch: insert.repositoryBranch ?? null,
      metadata: insert.metadata ?? null,
      createdAt: new Date(),
      completedAt: insert.completedAt ?? null,
    };
    this.buildHistoryMap.set(id, build);
    return build;
  }

  async getBuildHistory(options: { userId?: string; sessionId?: string; module?: string; limit?: number; offset?: number }): Promise<BuildHistory[]> {
    let builds = Array.from(this.buildHistoryMap.values());
    if (options.userId) builds = builds.filter(b => b.userId === options.userId);
    if (options.sessionId) builds = builds.filter(b => b.sessionId === options.sessionId);
    if (options.module) builds = builds.filter(b => b.module === options.module);
    builds.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return builds.slice(offset, offset + limit);
  }

  async getBuildById(id: string): Promise<BuildHistory | undefined> {
    return this.buildHistoryMap.get(id);
  }

  async getBuildByBuildId(buildId: string): Promise<BuildHistory | undefined> {
    return Array.from(this.buildHistoryMap.values()).find(b => b.buildId === buildId);
  }

  async updateBuildHistory(id: string, updates: Partial<InsertBuildHistory>): Promise<BuildHistory> {
    const existing = this.buildHistoryMap.get(id);
    if (!existing) throw new Error(`Build ${id} not found`);
    const updated = { ...existing, ...updates };
    this.buildHistoryMap.set(id, updated);
    return updated;
  }
}

import { PostgresStorage } from './storage-postgres';

const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.DATABASE_URL && isProduction) {
  throw new Error('DATABASE_URL is required in production. Configure PostgreSQL before starting the server.');
}

if (!process.env.DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL not set. Using in-memory storage (development only).');
}

// Production: PostgreSQL is mandatory. Development can use in-memory fallback.
export const storage = process.env.DATABASE_URL
  ? new PostgresStorage()
  : new MemStorage();
