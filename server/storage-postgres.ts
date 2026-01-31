import { db } from './db';
import { 
  users, 
  sessions, 
  messages, 
  generatedFiles 
} from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import type { IStorage } from './storage';
import type { 
  User, 
  Session, 
  Message, 
  GeneratedFile, 
  InsertUser, 
  InsertSession, 
  InsertMessage, 
  InsertGeneratedFile 
} from '@shared/schema';
import { randomUUID } from 'crypto';

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
      return result;
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
}

