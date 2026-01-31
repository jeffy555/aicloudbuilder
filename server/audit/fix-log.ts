/**
 * Fix Log Store
 * 
 * Tracks all fix operations for auditability and learning.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface FixLog {
  id: string;
  sessionId: string;
  checkId: string;
  resourceType: string;
  source: 'retrieved' | 'generated' | 'human';
  snippetId?: string;           // If retrieved from fix snippet store
  confidence: number;
  timestamp: Date;
  verificationStatus: 'pending' | 'passed' | 'failed';
  verificationDate?: Date;
  filePath?: string;
  resourceName?: string;
}

const DEFAULT_PERSISTENCE_FILE = '.cache/fix-logs.json';

class FixLogStore {
  private logs: FixLog[] = [];
  private persistenceFile: string;
  private isLoaded = false;

  constructor(persistenceFile: string = DEFAULT_PERSISTENCE_FILE) {
    this.persistenceFile = path.join(process.cwd(), persistenceFile);
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * Load logs from disk
   */
  async loadFromDisk(): Promise<void> {
    if (this.isLoaded) {
      return;
    }

    try {
      // Ensure directory exists
      const dir = path.dirname(this.persistenceFile);
      await fs.mkdir(dir, { recursive: true });

      // Try to read file
      const data = await fs.readFile(this.persistenceFile, 'utf-8');
      const logs: FixLog[] = JSON.parse(data);

      // Convert date strings back to Date objects
      for (const log of logs) {
        log.timestamp = new Date(log.timestamp);
        if (log.verificationDate) {
          log.verificationDate = new Date(log.verificationDate);
        }
        this.logs.push(log);
      }

      this.isLoaded = true;
      console.log(`📦 Loaded ${logs.length} fix log(s) from disk`);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log('📦 Fix log file not found, starting fresh.');
        this.isLoaded = true;
      } else {
        console.error('❌ Failed to load fix logs:', error.message);
        this.isLoaded = true;
      }
    }
  }

  /**
   * Save logs to disk
   */
  async saveToDisk(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.persistenceFile);
      await fs.mkdir(dir, { recursive: true });

      // Write to file
      await fs.writeFile(
        this.persistenceFile,
        JSON.stringify(this.logs, null, 2),
        'utf-8'
      );
    } catch (error: any) {
      console.error('❌ Failed to save fix logs:', error.message);
    }
  }

  /**
   * Add a new fix log entry
   */
  async add(log: Omit<FixLog, 'id' | 'timestamp'>): Promise<FixLog> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }

    const fullLog: FixLog = {
      ...log,
      id: this.generateId(),
      timestamp: new Date(),
    };

    this.logs.push(fullLog);

    // Save to disk (async, don't wait)
    this.saveToDisk().catch(err => {
      console.error('Failed to save fix logs:', err);
    });

    return fullLog;
  }

  /**
   * Update an existing log entry
   */
  async update(id: string, updates: Partial<FixLog>): Promise<void> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }

    const index = this.logs.findIndex(l => l.id === id);
    if (index >= 0) {
      this.logs[index] = { ...this.logs[index], ...updates };
      
      // Save to disk (async, don't wait)
      this.saveToDisk().catch(err => {
        console.error('Failed to save fix logs:', err);
      });
    }
  }

  /**
   * Get logs by session ID
   */
  async getBySession(sessionId: string): Promise<FixLog[]> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return this.logs.filter(l => l.sessionId === sessionId);
  }

  /**
   * Get logs by check ID
   */
  async getByCheckId(checkId: string): Promise<FixLog[]> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return this.logs.filter(l => l.checkId === checkId);
  }

  /**
   * Get logs by source
   */
  async getBySource(source: 'retrieved' | 'generated' | 'human'): Promise<FixLog[]> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return this.logs.filter(l => l.source === source);
  }

  /**
   * Get statistics
   */
  getStats(): {
    total: number;
    bySource: { [key: string]: number };
    byVerificationStatus: { [key: string]: number };
    averageConfidence: number;
    successRate: number;
  } {
    const bySource: { [key: string]: number } = {};
    const byVerificationStatus: { [key: string]: number } = {};
    let totalConfidence = 0;
    let verifiedCount = 0;
    let passedCount = 0;

    for (const log of this.logs) {
      bySource[log.source] = (bySource[log.source] || 0) + 1;
      byVerificationStatus[log.verificationStatus] = (byVerificationStatus[log.verificationStatus] || 0) + 1;
      
      totalConfidence += log.confidence;
      
      if (log.verificationStatus !== 'pending') {
        verifiedCount++;
        if (log.verificationStatus === 'passed') {
          passedCount++;
        }
      }
    }

    return {
      total: this.logs.length,
      bySource,
      byVerificationStatus,
      averageConfidence: this.logs.length > 0 ? totalConfidence / this.logs.length : 0,
      successRate: verifiedCount > 0 ? passedCount / verifiedCount : 0,
    };
  }

  /**
   * Get all logs (for debugging)
   */
  async getAll(): Promise<FixLog[]> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return [...this.logs];
  }
}

export const fixLogStore = new FixLogStore();




