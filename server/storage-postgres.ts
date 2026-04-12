import { db } from './db';
import {
  users,
  sessions,
  messages,
  generatedFiles,
  userActivities,
  architectureVersions,
  buildHistory,
} from '@shared/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import type { IStorage } from './storage';
import type {
  User,
  Session,
  Message,
  GeneratedFile,
  InsertUser,
  InsertSession,
  InsertMessage,
  InsertGeneratedFile,
  UserActivity,
  InsertUserActivity,
  ArchitectureVersion,
  InsertArchitectureVersion,
  BuildHistory,
  InsertBuildHistory,
} from '@shared/schema';
import { randomUUID } from 'crypto';
import { dedupeGeneratedFilesKeepNewest } from './utils/generated-files-dedupe';

export class PostgresStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    try {
      const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return result[0];
    } catch (error) {
      console.error('Error getting user:', error);
      throw error;
    }
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    try {
      const result = await db.select().from(users)
        .where(eq(users.username, username))
        .limit(1);
      return result[0];
    } catch (error) {
      console.error('Error getting user by username:', error);
      throw error;
    }
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    try {
      const id = randomUUID();
      const now = new Date();
      const [newUser] = await db.insert(users).values({
        id,
        username: insertUser.username,
        email: insertUser.email,
        password: insertUser.password,
        createdAt: now,
        updatedAt: now,
      }).returning();
      return newUser;
    } catch (error) {
      console.error('Error creating user:', error);
      throw error;
    }
  }

  async getUserById(id: string): Promise<User | undefined> {
    return this.getUser(id);
  }

  async getUserByMicrosoftId(microsoftId: string): Promise<User | undefined> {
    try {
      const result = await db.select().from(users)
        .where(eq(users.microsoftId, microsoftId))
        .limit(1);
      return result[0];
    } catch (error) {
      console.error('Error getting user by Microsoft ID:', error);
      throw error;
    }
  }

  async updateUserMicrosoftId(userId: string, microsoftId: string): Promise<User> {
    try {
      const [updated] = await db.update(users)
        .set({ microsoftId, authProvider: 'microsoft', updatedAt: new Date() })
        .where(eq(users.id, userId))
        .returning();
      return updated;
    } catch (error) {
      console.error('Error updating user Microsoft ID:', error);
      throw error;
    }
  }

  async getUserByAwsSub(awsSub: string): Promise<User | undefined> {
    try {
      const result = await db.select().from(users)
        .where(eq((users as any).awsSub, awsSub))
        .limit(1);
      return result[0];
    } catch (error) {
      console.error('Error getting user by AWS sub:', error);
      throw error;
    }
  }

  async updateUserAwsSub(userId: string, awsSub: string): Promise<User> {
    try {
      const [updated] = await db.update(users)
        .set({ awsSub, authProvider: 'aws', updatedAt: new Date() } as any)
        .where(eq(users.id, userId))
        .returning();
      return updated;
    } catch (error) {
      console.error('Error updating user AWS sub:', error);
      throw error;
    }
  }

  // Session methods
  async getSession(id: string): Promise<Session | undefined> {
    try {
      const result = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      if (result[0] && result[0].detectedTerraformFiles) {
        // Parse JSONB field if it's a string
        const session = result[0];
        if (typeof session.detectedTerraformFiles === 'string') {
          try {
            session.detectedTerraformFiles = JSON.parse(session.detectedTerraformFiles);
          } catch (e) {
            // If parsing fails, keep as is
          }
        }
        return session;
      }
      return result[0];
    } catch (error) {
      console.error('Error getting session:', error);
      throw error;
    }
  }

  async createSession(insertSession: InsertSession): Promise<Session> {
    try {
      const id = randomUUID();
      const now = new Date();
      
      // Prepare session data - include all fields from schema
      const sessionData: any = {
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
        detectedTerraformFiles: insertSession.detectedTerraformFiles 
          ? (typeof insertSession.detectedTerraformFiles === 'string' 
              ? insertSession.detectedTerraformFiles 
              : JSON.stringify(insertSession.detectedTerraformFiles))
          : null,
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

      const [newSession] = await db.insert(sessions).values(sessionData).returning();
      
      // Parse JSONB field for return
      if (newSession.detectedTerraformFiles && typeof newSession.detectedTerraformFiles === 'string') {
        try {
          newSession.detectedTerraformFiles = JSON.parse(newSession.detectedTerraformFiles);
        } catch (e) {
          // If parsing fails, keep as is
        }
      }
      
      return newSession;
    } catch (error) {
      console.error('Error creating session:', error);
      throw error;
    }
  }

  async updateSession(id: string, updates: Partial<InsertSession>): Promise<Session> {
    try {
      // Prepare update data
      const updateData: any = {
        ...updates,
        updatedAt: new Date(),
      };

      // Handle JSONB field
      if (updates.detectedTerraformFiles !== undefined) {
        updateData.detectedTerraformFiles = updates.detectedTerraformFiles
          ? (typeof updates.detectedTerraformFiles === 'string'
              ? updates.detectedTerraformFiles
              : JSON.stringify(updates.detectedTerraformFiles))
          : null;
      }

      const [updated] = await db.update(sessions)
        .set(updateData)
        .where(eq(sessions.id, id))
        .returning();

      if (!updated) {
        throw new Error('Session not found');
      }

      // Parse JSONB field for return
      if (updated.detectedTerraformFiles && typeof updated.detectedTerraformFiles === 'string') {
        try {
          updated.detectedTerraformFiles = JSON.parse(updated.detectedTerraformFiles);
        } catch (e) {
          // If parsing fails, keep as is
        }
      }

      return updated;
    } catch (error) {
      console.error('Error updating session:', error);
      throw error;
    }
  }

  // Message methods
  async getMessagesBySession(sessionId: string): Promise<Message[]> {
    try {
      const result = await db.select().from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(messages.createdAt);
      return result;
    } catch (error) {
      console.error('Error getting messages by session:', error);
      throw error;
    }
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    try {
      const id = randomUUID();
      const [newMessage] = await db.insert(messages).values({
        id,
        sessionId: insertMessage.sessionId,
        type: insertMessage.type,
        content: insertMessage.content,
        createdAt: new Date(),
      }).returning();
      return newMessage;
    } catch (error) {
      console.error('Error creating message:', error);
      throw error;
    }
  }

  // Generated file methods
  async getFilesBySession(sessionId: string): Promise<GeneratedFile[]> {
    try {
      const result = await db.select().from(generatedFiles)
        .where(eq(generatedFiles.sessionId, sessionId))
        .orderBy(generatedFiles.fileName);
      const { kept, removeIds } = dedupeGeneratedFilesKeepNewest(result);
      for (const id of removeIds) {
        await db.delete(generatedFiles).where(eq(generatedFiles.id, id));
      }
      if (removeIds.length > 0) {
        console.warn(
          `[generated_files] Removed ${removeIds.length} duplicate row(s) for session ${sessionId} (kept newest per filename).`
        );
      }
      return kept;
    } catch (error) {
      console.error('Error getting files by session:', error);
      throw error;
    }
  }

  async createFile(insertFile: InsertGeneratedFile): Promise<GeneratedFile> {
    try {
      const id = randomUUID();
      const now = new Date();
      const [newFile] = await db.insert(generatedFiles).values({
        id,
        sessionId: insertFile.sessionId,
        fileName: insertFile.fileName,
        content: insertFile.content,
        createdAt: now,
        updatedAt: now,
      }).returning();
      return newFile;
    } catch (error) {
      console.error('Error creating file:', error);
      throw error;
    }
  }

  async updateFile(id: string, content: string): Promise<GeneratedFile> {
    try {
      const [updated] = await db.update(generatedFiles)
        .set({ 
          content,
          updatedAt: new Date(),
        })
        .where(eq(generatedFiles.id, id))
        .returning();

      if (!updated) {
        throw new Error('File not found');
      }

      return updated;
    } catch (error) {
      console.error('Error updating file:', error);
      throw error;
    }
  }

  async deleteFile(id: string): Promise<void> {
    try {
      await db.delete(generatedFiles).where(eq(generatedFiles.id, id));
    } catch (error) {
      console.error('Error deleting file:', error);
      throw error;
    }
  }

  async deleteFilesBySession(sessionId: string): Promise<void> {
    try {
      await db.delete(generatedFiles).where(eq(generatedFiles.sessionId, sessionId));
    } catch (error) {
      console.error('Error deleting files by session:', error);
      throw error;
    }
  }

  // User history methods
  async getSessionsByUser(userId: string, options?: { module?: string; limit?: number; offset?: number }): Promise<Session[]> {
    try {
      const conditions = [eq(sessions.userId, userId)];
      if (options?.module) {
        conditions.push(eq(sessions.activeModule, options.module));
      }
      const result = await db.select().from(sessions)
        .where(and(...conditions))
        .orderBy(desc(sessions.updatedAt))
        .limit(options?.limit ?? 50)
        .offset(options?.offset ?? 0);
      return result;
    } catch (error) {
      console.error('Error getting sessions by user:', error);
      throw error;
    }
  }

  async getSessionCountByUser(userId: string): Promise<number> {
    try {
      const result = await db.select({ count: sql<number>`count(*)` })
        .from(sessions)
        .where(eq(sessions.userId, userId));
      return Number(result[0]?.count ?? 0);
    } catch (error) {
      console.error('Error getting session count by user:', error);
      throw error;
    }
  }

  async createUserActivity(activity: InsertUserActivity): Promise<UserActivity> {
    try {
      const id = randomUUID();
      const [record] = await db.insert(userActivities).values({
        id,
        userId: activity.userId,
        sessionId: activity.sessionId ?? null,
        module: activity.module,
        actionType: activity.actionType,
        actionLabel: activity.actionLabel,
        metadata: activity.metadata ?? null,
        createdAt: new Date(),
      }).returning();
      return record;
    } catch (error) {
      console.error('Error creating user activity:', error);
      throw error;
    }
  }

  async getUserActivities(userId: string, options?: { module?: string; limit?: number; offset?: number }): Promise<UserActivity[]> {
    try {
      const conditions = [eq(userActivities.userId, userId)];
      if (options?.module) {
        conditions.push(eq(userActivities.module, options.module));
      }
      const result = await db.select().from(userActivities)
        .where(and(...conditions))
        .orderBy(desc(userActivities.createdAt))
        .limit(options?.limit ?? 50)
        .offset(options?.offset ?? 0);
      return result;
    } catch (error) {
      console.error('Error getting user activities:', error);
      throw error;
    }
  }

  // Architecture version history methods
  async createArchitectureVersion(insert: InsertArchitectureVersion): Promise<ArchitectureVersion> {
    try {
      const id = randomUUID();
      const result = await db.insert(architectureVersions).values({
        id,
        ...insert,
      }).returning();
      return result[0];
    } catch (error) {
      console.error('Error creating architecture version:', error);
      throw error;
    }
  }

  async getArchitectureVersions(sessionId: string): Promise<ArchitectureVersion[]> {
    try {
      return await db.select().from(architectureVersions)
        .where(eq(architectureVersions.sessionId, sessionId))
        .orderBy(architectureVersions.version);
    } catch (error) {
      console.error('Error getting architecture versions:', error);
      throw error;
    }
  }

  async getArchitectureVersion(id: string): Promise<ArchitectureVersion | undefined> {
    try {
      const result = await db.select().from(architectureVersions)
        .where(eq(architectureVersions.id, id)).limit(1);
      return result[0];
    } catch (error) {
      console.error('Error getting architecture version:', error);
      throw error;
    }
  }

  // Build history methods
  async createBuildHistory(insert: InsertBuildHistory): Promise<BuildHistory> {
    try {
      const [result] = await db.insert(buildHistory).values({
        ...insert,
        id: randomUUID(),
      }).returning();
      return result;
    } catch (error) {
      console.error('Error creating build history:', error);
      throw error;
    }
  }

  async getBuildHistory(options: { userId?: string; sessionId?: string; module?: string; limit?: number; offset?: number }): Promise<BuildHistory[]> {
    try {
      const conditions = [];
      if (options.userId) conditions.push(eq(buildHistory.userId, options.userId));
      if (options.sessionId) conditions.push(eq(buildHistory.sessionId, options.sessionId));
      if (options.module) conditions.push(eq(buildHistory.module, options.module));

      const query = db.select().from(buildHistory);
      const withWhere = conditions.length > 0
        ? query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
        : query;

      return await withWhere
        .orderBy(desc(buildHistory.createdAt))
        .limit(options.limit ?? 50)
        .offset(options.offset ?? 0);
    } catch (error) {
      console.error('Error getting build history:', error);
      throw error;
    }
  }

  async getBuildById(id: string): Promise<BuildHistory | undefined> {
    try {
      const result = await db.select().from(buildHistory)
        .where(eq(buildHistory.id, id)).limit(1);
      return result[0];
    } catch (error) {
      console.error('Error getting build by id:', error);
      throw error;
    }
  }

  async getBuildByBuildId(buildId: string): Promise<BuildHistory | undefined> {
    try {
      const result = await db.select().from(buildHistory)
        .where(eq(buildHistory.buildId, buildId)).limit(1);
      return result[0];
    } catch (error) {
      console.error('Error getting build by buildId:', error);
      throw error;
    }
  }

  async updateBuildHistory(id: string, updates: Partial<InsertBuildHistory>): Promise<BuildHistory> {
    try {
      const [result] = await db.update(buildHistory)
        .set(updates)
        .where(eq(buildHistory.id, id))
        .returning();
      if (!result) throw new Error(`Build ${id} not found`);
      return result;
    } catch (error) {
      console.error('Error updating build history:', error);
      throw error;
    }
  }
}

