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
  type InsertUserActivity
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserById(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

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
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private sessions: Map<string, Session>;
  private messages: Map<string, Message>;
  private generatedFiles: Map<string, GeneratedFile>;
  private userActivitiesMap: Map<string, UserActivity>;

  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.messages = new Map();
    this.generatedFiles = new Map();
    this.userActivitiesMap = new Map();
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

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const now = new Date();
    const user: User = {
      ...insertUser,
      id,
      createdAt: now,
      updatedAt: now,
    };
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
    return Array.from(this.generatedFiles.values())
      .filter((file) => file.sessionId === sessionId)
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
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
