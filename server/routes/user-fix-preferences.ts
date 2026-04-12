/**
 * User Fix Preferences Routes
 *
 * Phase 2: REST API endpoints for managing user-specific fix preferences
 */

import type { Express } from 'express';
import { userFixPreferencesStore } from '../rag/user-fix-preferences-store';
import { requireAuth, optionalAuth } from '../middleware/auth';
import { validateRequest } from '../middleware/validate';
import { createPreferenceBody, updatePreferenceBody } from '@shared/api-contracts/user-fix-preferences';
import { insertUserFixPreferenceSchema } from '../../shared/schema';
import { z } from 'zod';

export function registerUserFixPreferencesRoutes(app: Express) {
  /**
   * GET /api/users/me/fix-preferences
   * Get all fix preferences for the authenticated user
   */
  app.get('/api/users/me/fix-preferences', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const limit = parseInt(req.query.limit as string) || 100;
      const offset = parseInt(req.query.offset as string) || 0;

      const preferences = await userFixPreferencesStore.getUserPreferences(
        userId,
        limit,
        offset
      );

      res.json({
        preferences,
        count: preferences.length,
        limit,
        offset,
      });
    } catch (error: any) {
      console.error('Error fetching preferences:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/users/me/fix-preferences/stats
   * Get statistics for user's fix preferences
   */
  app.get('/api/users/me/fix-preferences/stats', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const stats = await userFixPreferencesStore.getUserStats(userId);

      res.json(stats);
    } catch (error: any) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/users/me/fix-preferences/top
   * Get user's most used fixes
   */
  app.get('/api/users/me/fix-preferences/top', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const limit = parseInt(req.query.limit as string) || 10;

      const topFixes = await userFixPreferencesStore.getUserTopFixes(userId, limit);

      res.json({
        topFixes,
        count: topFixes.length,
      });
    } catch (error: any) {
      console.error('Error fetching top fixes:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/users/me/fix-preferences/search
   * Search preferences by check ID pattern
   */
  app.get('/api/users/me/fix-preferences/search', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const query = req.query.q as string;
      const limit = parseInt(req.query.limit as string) || 20;

      if (!query) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }

      const results = await userFixPreferencesStore.searchPreferences(
        userId,
        query,
        limit
      );

      res.json({
        results,
        count: results.length,
        query,
      });
    } catch (error: any) {
      console.error('Error searching preferences:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/users/me/fix-preferences/:checkId/:resourceType
   * Get specific preference by check ID and resource type
   */
  app.get(
    '/api/users/me/fix-preferences/:checkId/:resourceType',
    requireAuth,
    async (req, res) => {
      try {
        const userId = req.user!.id;
        const { checkId, resourceType } = req.params;

        const preference = await userFixPreferencesStore.getUserPreference(
          userId,
          checkId,
          resourceType
        );

        if (!preference) {
          return res.status(404).json({
            error: 'Preference not found',
            checkId,
            resourceType,
          });
        }

        res.json(preference);
      } catch (error: any) {
        console.error('Error fetching preference:', error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  /**
   * GET /api/fix-preferences/check/:checkId/:resourceType
   * Get all fixes for a specific check (across all users)
   * Optional authentication - shows more results for authenticated users
   */
  app.get(
    '/api/fix-preferences/check/:checkId/:resourceType',
    optionalAuth,
    async (req, res) => {
      try {
        const { checkId, resourceType } = req.params;
        const limit = parseInt(req.query.limit as string) || 20;

        const fixes = await userFixPreferencesStore.getFixesForCheck(
          checkId,
          resourceType,
          limit
        );

        res.json({
          fixes,
          count: fixes.length,
          checkId,
          resourceType,
        });
      } catch (error: any) {
        console.error('Error fetching fixes for check:', error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  /**
   * POST /api/users/me/fix-preferences
   * Create a new fix preference
   */
  app.post('/api/users/me/fix-preferences', requireAuth, validateRequest({ body: createPreferenceBody }), async (req, res) => {
    try {
      const userId = req.user!.id;

      // Validate request body
      const validationResult = insertUserFixPreferenceSchema.safeParse({
        ...req.body,
        userId,
      });

      if (!validationResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: validationResult.error.issues,
        });
      }

      const preference = await userFixPreferencesStore.storePreference(
        validationResult.data
      );

      res.status(201).json(preference);
    } catch (error: any) {
      console.error('Error creating preference:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * PUT /api/users/me/fix-preferences/:id
   * Update an existing preference
   */
  app.put('/api/users/me/fix-preferences/:id', requireAuth, validateRequest({ body: updatePreferenceBody }), async (req, res) => {
    try {
      const userId = req.user!.id;
      const { id } = req.params;

      // Verify ownership
      const existing = await userFixPreferencesStore.getUserPreferences(userId);
      const owned = existing.find(p => p.id === id);

      if (!owned) {
        return res.status(404).json({
          error: 'Preference not found or not owned by user',
        });
      }

      // Validate update data
      const updateSchema = z.object({
        fixSnippet: z.string().optional(),
        confidence: z.number().min(0).max(1.0).optional(),
        source: z.enum(['user_verified', 'checkov', 'ai_generated', 'user_preference']).optional(),
      });

      const validationResult = updateSchema.safeParse(req.body);

      if (!validationResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: validationResult.error.issues,
        });
      }

      const updated = await userFixPreferencesStore.updatePreference(
        id,
        validationResult.data
      );

      res.json(updated);
    } catch (error: any) {
      console.error('Error updating preference:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * POST /api/users/me/fix-preferences/:id/use
   * Increment usage counter (called when fix is applied)
   */
  app.post(
    '/api/users/me/fix-preferences/:id/use',
    requireAuth,
    async (req, res) => {
      try {
        const userId = req.user!.id;
        const { id } = req.params;
        const { success } = req.body;

        if (typeof success !== 'boolean') {
          return res.status(400).json({
            error: 'Field "success" (boolean) is required',
          });
        }

        // Verify ownership
        const existing = await userFixPreferencesStore.getUserPreferences(userId);
        const owned = existing.find(p => p.id === id);

        if (!owned) {
          return res.status(404).json({
            error: 'Preference not found or not owned by user',
          });
        }

        const updated = await userFixPreferencesStore.incrementUsage(id, success);

        res.json(updated);
      } catch (error: any) {
        console.error('Error incrementing usage:', error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  /**
   * DELETE /api/users/me/fix-preferences/:id
   * Delete a specific preference
   */
  app.delete('/api/users/me/fix-preferences/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { id } = req.params;

      // Verify ownership
      const existing = await userFixPreferencesStore.getUserPreferences(userId);
      const owned = existing.find(p => p.id === id);

      if (!owned) {
        return res.status(404).json({
          error: 'Preference not found or not owned by user',
        });
      }

      const deleted = await userFixPreferencesStore.deletePreference(id);

      if (deleted) {
        res.json({ success: true, message: 'Preference deleted' });
      } else {
        res.status(500).json({ error: 'Failed to delete preference' });
      }
    } catch (error: any) {
      console.error('Error deleting preference:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * DELETE /api/users/me/fix-preferences
   * Delete all preferences for the user
   */
  app.delete('/api/users/me/fix-preferences', requireAuth, async (req, res) => {
    try {
      const userId = req.user!.id;
      const count = await userFixPreferencesStore.deleteUserPreferences(userId);

      res.json({
        success: true,
        message: `Deleted ${count} preference(s)`,
        count,
      });
    } catch (error: any) {
      console.error('Error deleting preferences:', error);
      res.status(500).json({ error: error.message });
    }
  });

  /**
   * GET /api/users/me/fix-preferences/low-confidence
   * Get low confidence preferences (candidates for cleanup)
   */
  app.get(
    '/api/users/me/fix-preferences/low-confidence',
    requireAuth,
    async (req, res) => {
      try {
        const userId = req.user!.id;
        const threshold = parseFloat(req.query.threshold as string) || 0.3;

        const lowConfidence = await userFixPreferencesStore.getLowConfidencePreferences(
          userId,
          threshold
        );

        res.json({
          preferences: lowConfidence,
          count: lowConfidence.length,
          threshold,
        });
      } catch (error: any) {
        console.error('Error fetching low confidence preferences:', error);
        res.status(500).json({ error: error.message });
      }
    }
  );

  /**
   * POST /api/users/me/fix-preferences/cleanup
   * Delete all low confidence preferences
   */
  app.post(
    '/api/users/me/fix-preferences/cleanup',
    requireAuth,
    async (req, res) => {
      try {
        const userId = req.user!.id;
        const threshold = parseFloat(req.body.threshold) || 0.3;

        const count = await userFixPreferencesStore.cleanupLowConfidencePreferences(
          userId,
          threshold
        );

        res.json({
          success: true,
          message: `Cleaned up ${count} low confidence preference(s)`,
          count,
          threshold,
        });
      } catch (error: any) {
        console.error('Error cleaning up preferences:', error);
        res.status(500).json({ error: error.message });
      }
    }
  );
}
