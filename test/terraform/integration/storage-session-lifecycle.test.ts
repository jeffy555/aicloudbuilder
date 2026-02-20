
import { MemStorage } from '../../../server/storage.js';
import type { IStorage } from '../../../server/storage.js';

describe('Storage Session Lifecycle', () => {
  let storage: IStorage;

  beforeEach(() => {
    storage = new MemStorage();
  });

  describe('session creation', () => {
    it('creates session with userId', async () => {
      const session = await storage.createSession({ userId: 'user-123' });
      expect(session.id).toBeDefined();
      expect(session.userId).toBe('user-123');
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.updatedAt).toBeInstanceOf(Date);
    });

    it('creates session with activeModule terraform', async () => {
      const session = await storage.createSession({
        userId: 'user-123',
        activeModule: 'terraform',
      });
      expect(session.activeModule).toBe('terraform');
    });

    it('creates session with default values', async () => {
      const session = await storage.createSession({ userId: null });
      expect(session.currentStep).toBe('1');
      expect(session.workflowStep).toBe('landing');
      expect(session.provider).toBeNull();
      expect(session.cloudProvider).toBeNull();
    });

    it('creates session with full terraform state', async () => {
      const session = await storage.createSession({
        userId: 'user-123',
        provider: 'github',
        cloudProvider: 'azure',
        moduleApproach: 'aggregated-root',
        activeModule: 'terraform',
        currentStep: '5',
        workflowStep: 'terraform_generation',
        hasBackend: 'true',
        backendType: 'azurerm',
        backendStorageAccount: 'mystorageacct',
        backendResourceGroup: 'terraform-state-rg',
        backendContainer: 'tfstate',
      });

      expect(session.provider).toBe('github');
      expect(session.cloudProvider).toBe('azure');
      expect(session.moduleApproach).toBe('aggregated-root');
      expect(session.hasBackend).toBe('true');
      expect(session.backendStorageAccount).toBe('mystorageacct');
    });
  });

  describe('session retrieval', () => {
    it('retrieves session by ID', async () => {
      const created = await storage.createSession({ userId: 'user-123' });
      const retrieved = await storage.getSession(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.userId).toBe('user-123');
    });

    it('returns undefined for non-existent session', async () => {
      const result = await storage.getSession('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('session updates', () => {
    it('updates session fields via PATCH', async () => {
      const session = await storage.createSession({ userId: 'user-123' });

      const updated = await storage.updateSession(session.id, {
        cloudProvider: 'azure',
        moduleApproach: 'child-module',
        currentStep: '4',
      });

      expect(updated.cloudProvider).toBe('azure');
      expect(updated.moduleApproach).toBe('child-module');
      expect(updated.currentStep).toBe('4');
    });

    it('preserves unmodified fields on update', async () => {
      const session = await storage.createSession({
        userId: 'user-123',
        provider: 'github',
        cloudProvider: 'azure',
      });

      const updated = await storage.updateSession(session.id, {
        currentStep: '3',
      });

      expect(updated.provider).toBe('github');
      expect(updated.cloudProvider).toBe('azure');
      expect(updated.currentStep).toBe('3');
    });

    it('updates updatedAt timestamp on update', async () => {
      const session = await storage.createSession({ userId: 'user-123' });
      const originalUpdatedAt = session.updatedAt;

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = await storage.updateSession(session.id, {
        currentStep: '2',
      });

      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(originalUpdatedAt.getTime());
    });

    it('throws error when updating non-existent session', async () => {
      await expect(
        storage.updateSession('non-existent', { currentStep: '2' })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('message management', () => {
    it('stores and retrieves messages', async () => {
      const session = await storage.createSession({ userId: 'user-123' });

      const msg = await storage.createMessage({
        sessionId: session.id,
        type: 'user',
        content: 'Create an Azure resource group',
      });

      expect(msg.id).toBeDefined();
      expect(msg.content).toBe('Create an Azure resource group');

      const messages = await storage.getMessagesBySession(session.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Create an Azure resource group');
    });

    it('sorts messages by creation time', async () => {
      const session = await storage.createSession({ userId: 'user-123' });

      await storage.createMessage({
        sessionId: session.id,
        type: 'user',
        content: 'First message',
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      await storage.createMessage({
        sessionId: session.id,
        type: 'ai',
        content: 'Second message',
      });

      const messages = await storage.getMessagesBySession(session.id);
      expect(messages[0].content).toBe('First message');
      expect(messages[1].content).toBe('Second message');
    });

    it('returns empty array for session with no messages', async () => {
      const session = await storage.createSession({ userId: 'user-123' });
      const messages = await storage.getMessagesBySession(session.id);
      expect(messages).toHaveLength(0);
    });
  });

  describe('file management', () => {
    it('stores and retrieves files', async () => {
      const session = await storage.createSession({ userId: 'user-123' });

      const file = await storage.createFile({
        sessionId: session.id,
        fileName: 'main.tf',
        content: 'resource "azurerm_resource_group" "main" {}',
      });

      expect(file.id).toBeDefined();
      expect(file.fileName).toBe('main.tf');

      const files = await storage.getFilesBySession(session.id);
      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('main.tf');
    });

    it('updates file content', async () => {
      const session = await storage.createSession({ userId: 'user-123' });

      const file = await storage.createFile({
        sessionId: session.id,
        fileName: 'main.tf',
        content: 'original content',
      });

      const updated = await storage.updateFile(file.id, 'updated content');
      expect(updated.content).toBe('updated content');
    });

    it('deletes a file', async () => {
      const session = await storage.createSession({ userId: 'user-123' });

      const file = await storage.createFile({
        sessionId: session.id,
        fileName: 'main.tf',
        content: 'content',
      });

      await storage.deleteFile(file.id);
      const files = await storage.getFilesBySession(session.id);
      expect(files).toHaveLength(0);
    });

    it('deletes all files by session', async () => {
      const session = await storage.createSession({ userId: 'user-123' });

      await storage.createFile({ sessionId: session.id, fileName: 'main.tf', content: 'a' });
      await storage.createFile({ sessionId: session.id, fileName: 'variables.tf', content: 'b' });
      await storage.createFile({ sessionId: session.id, fileName: 'outputs.tf', content: 'c' });

      let files = await storage.getFilesBySession(session.id);
      expect(files).toHaveLength(3);

      await storage.deleteFilesBySession(session.id);

      files = await storage.getFilesBySession(session.id);
      expect(files).toHaveLength(0);
    });

    it('throws error when updating non-existent file', async () => {
      await expect(
        storage.updateFile('non-existent', 'content')
      ).rejects.toThrow('File not found');
    });
  });

  describe('user history - getSessionsByUser', () => {
    it('returns sessions for a specific user', async () => {
      await storage.createSession({ userId: 'user-1', activeModule: 'terraform' });
      await storage.createSession({ userId: 'user-1', activeModule: 'kubernetes' });
      await storage.createSession({ userId: 'user-2', activeModule: 'terraform' });

      const user1Sessions = await storage.getSessionsByUser('user-1');
      expect(user1Sessions).toHaveLength(2);

      const user2Sessions = await storage.getSessionsByUser('user-2');
      expect(user2Sessions).toHaveLength(1);
    });

    it('excludes other users sessions', async () => {
      await storage.createSession({ userId: 'user-1' });
      await storage.createSession({ userId: 'user-2' });

      const sessions = await storage.getSessionsByUser('user-1');
      sessions.forEach(s => {
        expect(s.userId).toBe('user-1');
      });
    });

    it('filters by module', async () => {
      await storage.createSession({ userId: 'user-1', activeModule: 'terraform' });
      await storage.createSession({ userId: 'user-1', activeModule: 'kubernetes' });

      const terraformSessions = await storage.getSessionsByUser('user-1', { module: 'terraform' });
      expect(terraformSessions).toHaveLength(1);
      expect(terraformSessions[0].activeModule).toBe('terraform');
    });

    it('paginates results', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.createSession({ userId: 'user-1' });
      }

      const page1 = await storage.getSessionsByUser('user-1', { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = await storage.getSessionsByUser('user-1', { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = await storage.getSessionsByUser('user-1', { limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });

    it('returns empty array for user with no sessions', async () => {
      const sessions = await storage.getSessionsByUser('non-existent');
      expect(sessions).toHaveLength(0);
    });
  });

  describe('user history - getSessionCountByUser', () => {
    it('returns accurate count', async () => {
      await storage.createSession({ userId: 'user-1' });
      await storage.createSession({ userId: 'user-1' });
      await storage.createSession({ userId: 'user-2' });

      expect(await storage.getSessionCountByUser('user-1')).toBe(2);
      expect(await storage.getSessionCountByUser('user-2')).toBe(1);
      expect(await storage.getSessionCountByUser('non-existent')).toBe(0);
    });
  });

  describe('user activities', () => {
    it('creates and retrieves activities', async () => {
      const activity = await storage.createUserActivity({
        userId: 'user-1',
        sessionId: null,
        module: 'scoreme',
        actionType: 'score_run',
        actionLabel: 'ScoreMe: repo-name (85/100)',
        metadata: { finalScore: 85 },
      });

      expect(activity.id).toBeDefined();
      expect(activity.module).toBe('scoreme');

      const activities = await storage.getUserActivities('user-1');
      expect(activities).toHaveLength(1);
      expect(activities[0].actionLabel).toContain('ScoreMe');
    });

    it('filters activities by module', async () => {
      await storage.createUserActivity({
        userId: 'user-1', sessionId: null, module: 'scoreme',
        actionType: 'score_run', actionLabel: 'ScoreMe run',
      });
      await storage.createUserActivity({
        userId: 'user-1', sessionId: null, module: 'terraform',
        actionType: 'generate', actionLabel: 'Terraform generate',
      });

      const scoremeActivities = await storage.getUserActivities('user-1', { module: 'scoreme' });
      expect(scoremeActivities).toHaveLength(1);
      expect(scoremeActivities[0].module).toBe('scoreme');
    });

    it('paginates activities', async () => {
      for (let i = 0; i < 5; i++) {
        await storage.createUserActivity({
          userId: 'user-1', sessionId: null, module: 'scoreme',
          actionType: 'score_run', actionLabel: `Run ${i}`,
        });
      }

      const page1 = await storage.getUserActivities('user-1', { limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = await storage.getUserActivities('user-1', { limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);
    });

    it('isolates activities by user', async () => {
      await storage.createUserActivity({
        userId: 'user-1', sessionId: null, module: 'scoreme',
        actionType: 'run', actionLabel: 'User 1 activity',
      });
      await storage.createUserActivity({
        userId: 'user-2', sessionId: null, module: 'scoreme',
        actionType: 'run', actionLabel: 'User 2 activity',
      });

      const user1Activities = await storage.getUserActivities('user-1');
      expect(user1Activities).toHaveLength(1);
      expect(user1Activities[0].actionLabel).toBe('User 1 activity');
    });
  });

  describe('concurrent operations', () => {
    it('handles concurrent session creation', async () => {
      const promises = Array.from({ length: 10 }, (_, i) =>
        storage.createSession({ userId: `user-${i}` })
      );

      const sessions = await Promise.all(promises);
      expect(sessions).toHaveLength(10);

      // All IDs should be unique
      const ids = new Set(sessions.map(s => s.id));
      expect(ids.size).toBe(10);
    });

    it('handles concurrent file creation', async () => {
      const session = await storage.createSession({ userId: 'user-1' });

      const promises = Array.from({ length: 5 }, (_, i) =>
        storage.createFile({
          sessionId: session.id,
          fileName: `file-${i}.tf`,
          content: `resource "type_${i}" "name_${i}" {}`,
        })
      );

      const files = await Promise.all(promises);
      expect(files).toHaveLength(5);

      const sessionFiles = await storage.getFilesBySession(session.id);
      expect(sessionFiles).toHaveLength(5);
    });
  });
});
