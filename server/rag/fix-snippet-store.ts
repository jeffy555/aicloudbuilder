/**
 * Fix Snippet Store
 * 
 * Stores and manages fix snippets in a persistent vector DB system.
 * Replaces the YAML template system with a self-extending fix database.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export type IaCFramework = 'terraform' | 'kubernetes';

export interface FixSnippet {
  id: string;                    // Unique ID (hash of checkId + resourceType + framework)
  checkId: string;               // CKV_AZURE_59, CKV_K8S_20
  resourceType: string;          // azurerm_storage_account, Deployment
  cloudProvider: string;         // azure | aws | gcp | kubernetes
  framework: IaCFramework;       // terraform | kubernetes - IaC framework type
  fixSnippet: string;            // HCL or YAML snippet
  context: string;               // Full resource block example
  guideline: string;             // Checkov guideline
  source: 'retrieved' | 'generated' | 'human';
  confidence: number;            // 0.0 - 1.0
  successCount: number;          // Times this fix worked
  failureCount: number;          // Times this fix failed
  verified: boolean;             // Has been verified by Checkov
  deprecated: boolean;           // Should not be used
  lastUsed: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FixSnippetResult {
  snippet: FixSnippet;
  source: 'retrieved' | 'generated';
  confidence: number;
  matchReason: string;
}

const DEFAULT_PERSISTENCE_FILE = '.cache/fix-snippets.json';

class FixSnippetStore {
  private snippets: Map<string, FixSnippet> = new Map();
  private persistenceFile: string;
  private isLoaded = false;

  constructor(persistenceFile: string = DEFAULT_PERSISTENCE_FILE) {
    this.persistenceFile = path.join(process.cwd(), persistenceFile);
  }

  /**
   * Generate unique ID from checkId, resourceType, and framework
   */
  private generateId(checkId: string, resourceType: string, framework: IaCFramework = 'terraform'): string {
    const key = `${checkId}:${resourceType}:${framework}`;
    return createHash('sha256').update(key).digest('hex').substring(0, 16);
  }

  /**
   * Load snippets from disk
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
      const snippets: FixSnippet[] = JSON.parse(data);

      // Convert date strings back to Date objects and ensure framework field exists
      for (const snippet of snippets) {
        snippet.lastUsed = new Date(snippet.lastUsed);
        snippet.createdAt = new Date(snippet.createdAt);
        snippet.updatedAt = new Date(snippet.updatedAt);
        // Backward compatibility: default framework to 'terraform' for existing snippets
        if (!snippet.framework) {
          snippet.framework = 'terraform';
        }
        this.snippets.set(snippet.id, snippet);
      }

      this.isLoaded = true;
      // loaded — caller reads stats via getStats()
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // no snippet file yet — starting fresh
        this.isLoaded = true;
      } else {
        console.error('❌ Failed to load fix snippets:', error.message);
        this.isLoaded = true;
      }
    }
  }

  /**
   * Save snippets to disk
   */
  async saveToDisk(): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.persistenceFile);
      await fs.mkdir(dir, { recursive: true });

      // Convert Map to array
      const snippets = Array.from(this.snippets.values());

      // Write to file
      await fs.writeFile(
        this.persistenceFile,
        JSON.stringify(snippets, null, 2),
        'utf-8'
      );

      console.log(`💾 Saved ${snippets.length} fix snippet(s) to disk`);
    } catch (error: any) {
      console.error('❌ Failed to save fix snippets:', error.message);
    }
  }

  /**
   * Get snippet by ID
   */
  async get(id: string): Promise<FixSnippet | null> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return this.snippets.get(id) || null;
  }

  /**
   * Get snippet by checkId + resourceType + framework (exact match)
   */
  async getByKey(checkId: string, resourceType: string, framework: IaCFramework = 'terraform'): Promise<FixSnippet | null> {
    const id = this.generateId(checkId, resourceType, framework);
    return this.get(id);
  }

  /**
   * Store new snippet
   */
  async store(snippet: Omit<FixSnippet, 'id'> & { id?: string }): Promise<FixSnippet> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }

    // Default framework to 'terraform' for backward compatibility
    const framework = snippet.framework || 'terraform';

    // Generate ID if not provided (includes framework)
    const id = snippet.id || this.generateId(snippet.checkId, snippet.resourceType, framework);

    // Create full snippet
    const fullSnippet: FixSnippet = {
      ...snippet,
      id,
      framework,
      createdAt: snippet.createdAt || new Date(),
      updatedAt: new Date()
    };

    // Store in Map
    this.snippets.set(id, fullSnippet);

    // Save to disk (async, don't wait)
    this.saveToDisk().catch(err => {
      console.error('Failed to save fix snippets:', err);
    });

    return fullSnippet;
  }

  /**
   * Update existing snippet
   */
  async update(id: string, updates: Partial<FixSnippet>): Promise<void> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }

    const snippet = this.snippets.get(id);
    if (!snippet) {
      throw new Error(`Fix snippet not found: ${id}`);
    }

    // Update snippet
    const updated: FixSnippet = {
      ...snippet,
      ...updates,
      updatedAt: new Date()
    };

    this.snippets.set(id, updated);

    // Save to disk (async, don't wait)
    this.saveToDisk().catch(err => {
      console.error('Failed to save fix snippets:', err);
    });
  }

  /**
   * Get all snippets (for migration/debugging)
   */
  async getAll(): Promise<FixSnippet[]> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return Array.from(this.snippets.values());
  }

  /**
   * Get snippets by checkId
   */
  async getByCheckId(checkId: string): Promise<FixSnippet[]> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return Array.from(this.snippets.values()).filter(s => s.checkId === checkId);
  }

  /**
   * Get non-deprecated snippets
   */
  async getActive(): Promise<FixSnippet[]> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return Array.from(this.snippets.values()).filter(s => !s.deprecated);
  }

  /**
   * Get snippets by framework (terraform or kubernetes)
   */
  async getByFramework(framework: IaCFramework): Promise<FixSnippet[]> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }
    return Array.from(this.snippets.values()).filter(s => s.framework === framework && !s.deprecated);
  }

  /**
   * Delete snippet
   */
  async delete(id: string): Promise<void> {
    if (!this.isLoaded) {
      await this.loadFromDisk();
    }

    this.snippets.delete(id);

    // Save to disk (async, don't wait)
    this.saveToDisk().catch(err => {
      console.error('Failed to save fix snippets:', err);
    });
  }

  /**
   * Get statistics
   */
  /**
   * Get count of verified, non-deprecated snippets.
   * Used by Phase 5 template deprecation gate.
   */
  getVerifiedCount(): number {
    return Array.from(this.snippets.values()).filter(s => s.verified && !s.deprecated).length;
  }

  getStats(): {
    total: number;
    active: number;
    deprecated: number;
    bySource: { [key: string]: number };
    byCloudProvider: { [key: string]: number };
    byFramework: { [key: string]: number };
  } {
    const snippets = Array.from(this.snippets.values());

    return {
      total: snippets.length,
      active: snippets.filter(s => !s.deprecated).length,
      deprecated: snippets.filter(s => s.deprecated).length,
      bySource: snippets.reduce((acc, s) => {
        acc[s.source] = (acc[s.source] || 0) + 1;
        return acc;
      }, {} as { [key: string]: number }),
      byCloudProvider: snippets.reduce((acc, s) => {
        acc[s.cloudProvider] = (acc[s.cloudProvider] || 0) + 1;
        return acc;
      }, {} as { [key: string]: number }),
      byFramework: snippets.reduce((acc, s) => {
        const framework = s.framework || 'terraform';
        acc[framework] = (acc[framework] || 0) + 1;
        return acc;
      }, {} as { [key: string]: number })
    };
  }
}

export const fixSnippetStore = new FixSnippetStore();
export { FixSnippetStore, IaCFramework };




