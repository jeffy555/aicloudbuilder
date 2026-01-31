/**
 * User Fix Preferences Store
 *
 * Phase 2: Service layer for managing user-specific fix preferences
 *
 * Provides CRUD operations and business logic for user fix preferences,
 * enabling personalized remediation strategies for Checkov security issues.
 */

import { db } from '../db';
import { userFixPreferences, type UserFixPreference, type InsertUserFixPreference } from '../../shared/schema';
import { eq, and, desc, sql } from 'drizzle-orm';

export interface UserFixPreferenceStats {
  totalPreferences: number;
  totalUsages: number;
  successRate: number;
  averageConfidence: number;
  bySource: Record<string, number>;
  topFixes: Array<{
    checkId: string;
    resourceType: string;
    timesUsed: number;
    successRate: number;
  }>;
}

export class UserFixPreferencesStore {
  /**
   * Get user-specific fix preference by check ID and resource type
   */
  async getUserPreference(
    userId: string,
    checkId: string,
    resourceType: string
  ): Promise<UserFixPreference | null> {
    const results = await db
      .select()
      .from(userFixPreferences)
      .where(
        and(
          eq(userFixPreferences.userId, userId),
          eq(userFixPreferences.checkId, checkId),
          eq(userFixPreferences.resourceType, resourceType)
        )
      )
      .limit(1);

    return results[0] || null;
  }

  /**
   * Get all fix preferences for a user
   */
  async getUserPreferences(
    userId: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<UserFixPreference[]> {
    return await db
      .select()
      .from(userFixPreferences)
      .where(eq(userFixPreferences.userId, userId))
      .orderBy(desc(userFixPreferences.timesUsed))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Get user's most used fixes
   */
  async getUserTopFixes(
    userId: string,
    limit: number = 10
  ): Promise<UserFixPreference[]> {
    return await db
      .select()
      .from(userFixPreferences)
      .where(eq(userFixPreferences.userId, userId))
      .orderBy(desc(userFixPreferences.timesUsed))
      .limit(limit);
  }

  /**
   * Get all fixes for a specific check (across all users)
   */
  async getFixesForCheck(
    checkId: string,
    resourceType: string,
    limit: number = 20
  ): Promise<UserFixPreference[]> {
    return await db
      .select()
      .from(userFixPreferences)
      .where(
        and(
          eq(userFixPreferences.checkId, checkId),
          eq(userFixPreferences.resourceType, resourceType)
        )
      )
      .orderBy(desc(userFixPreferences.confidence))
      .limit(limit);
  }

  /**
   * Store a new user preference
   */
  async storePreference(
    data: InsertUserFixPreference
  ): Promise<UserFixPreference> {
    // Check if preference already exists
    const existing = await this.getUserPreference(
      data.userId,
      data.checkId,
      data.resourceType
    );

    if (existing) {
      // Update existing preference
      return await this.updatePreference(existing.id, {
        fixSnippet: data.fixSnippet,
        confidence: data.confidence || existing.confidence,
        source: data.source,
        updatedAt: new Date(),
      });
    }

    // Insert new preference
    const [result] = await db
      .insert(userFixPreferences)
      .values({
        ...data,
        lastUsedAt: new Date(),
      })
      .returning();

    return result;
  }

  /**
   * Update an existing preference
   */
  async updatePreference(
    id: string,
    updates: Partial<UserFixPreference>
  ): Promise<UserFixPreference> {
    const [result] = await db
      .update(userFixPreferences)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(userFixPreferences.id, id))
      .returning();

    if (!result) {
      throw new Error(`Preference ${id} not found`);
    }

    return result;
  }

  /**
   * Increment usage counter and update statistics
   */
  async incrementUsage(
    id: string,
    success: boolean
  ): Promise<UserFixPreference> {
    const pref = await db
      .select()
      .from(userFixPreferences)
      .where(eq(userFixPreferences.id, id))
      .limit(1);

    if (!pref[0]) {
      throw new Error(`Preference ${id} not found`);
    }

    const updates = {
      timesUsed: pref[0].timesUsed + 1,
      successCount: success ? pref[0].successCount + 1 : pref[0].successCount,
      failureCount: success ? pref[0].failureCount : pref[0].failureCount + 1,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    };

    // Adjust confidence based on success/failure
    let newConfidence = pref[0].confidence;
    if (success) {
      // Increase confidence on success (max 1.0)
      newConfidence = Math.min(1.0, newConfidence + 0.05);
    } else {
      // Decrease confidence on failure (min 0.0)
      newConfidence = Math.max(0.0, newConfidence - 0.1);
    }

    const [result] = await db
      .update(userFixPreferences)
      .set({
        ...updates,
        confidence: newConfidence,
      })
      .where(eq(userFixPreferences.id, id))
      .returning();

    return result;
  }

  /**
   * Delete a preference
   */
  async deletePreference(id: string): Promise<boolean> {
    const result = await db
      .delete(userFixPreferences)
      .where(eq(userFixPreferences.id, id))
      .returning();

    return result.length > 0;
  }

  /**
   * Delete all preferences for a user
   */
  async deleteUserPreferences(userId: string): Promise<number> {
    const result = await db
      .delete(userFixPreferences)
      .where(eq(userFixPreferences.userId, userId))
      .returning();

    return result.length;
  }

  /**
   * Get statistics for a user
   */
  async getUserStats(userId: string): Promise<UserFixPreferenceStats> {
    const prefs = await db
      .select()
      .from(userFixPreferences)
      .where(eq(userFixPreferences.userId, userId));

    if (prefs.length === 0) {
      return {
        totalPreferences: 0,
        totalUsages: 0,
        successRate: 0,
        averageConfidence: 0,
        bySource: {},
        topFixes: [],
      };
    }

    // Calculate statistics
    const totalUsages = prefs.reduce((sum, p) => sum + p.timesUsed, 0);
    const totalSuccesses = prefs.reduce((sum, p) => sum + p.successCount, 0);
    const totalAttempts = prefs.reduce((sum, p) => sum + p.successCount + p.failureCount, 0);
    const successRate = totalAttempts > 0 ? totalSuccesses / totalAttempts : 0;
    const averageConfidence = prefs.reduce((sum, p) => sum + p.confidence, 0) / prefs.length;

    // Count by source
    const bySource: Record<string, number> = {};
    for (const pref of prefs) {
      bySource[pref.source] = (bySource[pref.source] || 0) + 1;
    }

    // Top fixes
    const topFixes = prefs
      .sort((a, b) => b.timesUsed - a.timesUsed)
      .slice(0, 10)
      .map(p => ({
        checkId: p.checkId,
        resourceType: p.resourceType,
        timesUsed: p.timesUsed,
        successRate: (p.successCount + p.failureCount) > 0
          ? p.successCount / (p.successCount + p.failureCount)
          : 0,
      }));

    return {
      totalPreferences: prefs.length,
      totalUsages,
      successRate,
      averageConfidence,
      bySource,
      topFixes,
    };
  }

  /**
   * Search preferences by check ID pattern
   */
  async searchPreferences(
    userId: string,
    searchTerm: string,
    limit: number = 20
  ): Promise<UserFixPreference[]> {
    return await db
      .select()
      .from(userFixPreferences)
      .where(
        and(
          eq(userFixPreferences.userId, userId),
          sql`${userFixPreferences.checkId} ILIKE ${`%${searchTerm}%`}`
        )
      )
      .orderBy(desc(userFixPreferences.confidence))
      .limit(limit);
  }

  /**
   * Get preferences by source
   */
  async getPreferencesBySource(
    userId: string,
    source: string,
    limit: number = 50
  ): Promise<UserFixPreference[]> {
    return await db
      .select()
      .from(userFixPreferences)
      .where(
        and(
          eq(userFixPreferences.userId, userId),
          eq(userFixPreferences.source, source)
        )
      )
      .orderBy(desc(userFixPreferences.timesUsed))
      .limit(limit);
  }

  /**
   * Get low confidence preferences (candidates for removal)
   */
  async getLowConfidencePreferences(
    userId: string,
    threshold: number = 0.3
  ): Promise<UserFixPreference[]> {
    return await db
      .select()
      .from(userFixPreferences)
      .where(
        and(
          eq(userFixPreferences.userId, userId),
          sql`${userFixPreferences.confidence} < ${threshold}`
        )
      )
      .orderBy(userFixPreferences.confidence);
  }

  /**
   * Bulk delete low confidence preferences
   */
  async cleanupLowConfidencePreferences(
    userId: string,
    threshold: number = 0.3
  ): Promise<number> {
    const result = await db
      .delete(userFixPreferences)
      .where(
        and(
          eq(userFixPreferences.userId, userId),
          sql`${userFixPreferences.confidence} < ${threshold}`
        )
      )
      .returning();

    return result.length;
  }

  /**
   * Check if preference exists
   */
  async exists(
    userId: string,
    checkId: string,
    resourceType: string
  ): Promise<boolean> {
    const result = await db
      .select({ id: userFixPreferences.id })
      .from(userFixPreferences)
      .where(
        and(
          eq(userFixPreferences.userId, userId),
          eq(userFixPreferences.checkId, checkId),
          eq(userFixPreferences.resourceType, resourceType)
        )
      )
      .limit(1);

    return result.length > 0;
  }
}

// Singleton instance
export const userFixPreferencesStore = new UserFixPreferencesStore();
