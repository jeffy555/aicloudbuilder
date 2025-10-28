import { 
  type User, 
  type InsertUser,
  type Session,
  type InsertSession,
  type Message,
  type InsertMessage,
  type GeneratedFile,
  type InsertGeneratedFile
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
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
  deleteFilesBySession(sessionId: string): Promise<void>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private sessions: Map<string, Session>;
  private messages: Map<string, Message>;
  private generatedFiles: Map<string, GeneratedFile>;

  constructor() {
    this.users = new Map();
    this.sessions = new Map();
    this.messages = new Map();
    this.generatedFiles = new Map();
  }

  // User methods
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
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
      provider: insertSession.provider ?? null,
      repositoryId: insertSession.repositoryId ?? null,
      repositoryName: insertSession.repositoryName ?? null,
      cloudProvider: insertSession.cloudProvider ?? null,
      currentStep: insertSession.currentStep ?? '1',
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

  async deleteFilesBySession(sessionId: string): Promise<void> {
    const fileIds = Array.from(this.generatedFiles.values())
      .filter((file) => file.sessionId === sessionId)
      .map((file) => file.id);
    
    fileIds.forEach((id) => this.generatedFiles.delete(id));
  }
}

export const storage = new MemStorage();
