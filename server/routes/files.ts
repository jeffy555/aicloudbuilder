import type { Express } from "express";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import { sessionIdParams, fileIdParams } from "@shared/api-contracts/common";
import { createFileBody, bulkFilesBody, updateFileBody } from "@shared/api-contracts/files";
import { fileBasenameKey } from "../utils/generated-files-dedupe";

/**
 * File management routes
 */
export function registerFileRoutes(app: Express): void {
  // Get generated files
  app.get("/api/sessions/:id/files", async (req, res) => {
    try {
      const sessionId = req.params.id;
      
      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      
      const files = await storage.getFilesBySession(sessionId);
      
      // Debug logging
      console.log(`📁 GET /api/sessions/${sessionId}/files`);
      console.log(`   Found ${files.length} file(s)`);
      files.forEach((f, i) => {
        console.log(`   ${i + 1}. ${f.fileName} (sessionId: ${f.sessionId}, size: ${f.content.length} bytes)`);
      });
      
      res.json(files);
    } catch (error) {
      console.error('Error getting files:', error);
      res.status(500).json({ error: 'Failed to get files' });
    }
  });

  // Create a file (for testing)
  app.post("/api/sessions/:id/files", validateRequest({ params: sessionIdParams, body: createFileBody }), async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { fileName, content } = req.body;
      
      if (!fileName || content === undefined) {
        return res.status(400).json({ error: 'fileName and content are required' });
      }

      // Check if file already exists for this session
      const existingFiles = await storage.getFilesBySession(sessionId);
      const key = fileBasenameKey(fileName);
      const existingFile = existingFiles.find((f) => fileBasenameKey(f.fileName) === key);

      if (existingFile) {
        // Update existing file
        const updated = await storage.updateFile(existingFile.id, content);
        console.log(`📝 Updated existing file in session: ${fileName} (${content.length} bytes)`);
        res.json(updated);
      } else {
        // Create new file
        const file = await storage.createFile({
          sessionId,
          fileName,
          content,
        });
        console.log(`➕ Created new file in session: ${fileName} (${content.length} bytes)`);
        res.status(201).json(file);
      }
    } catch (error) {
      console.error('Error creating/updating file:', error);
      res.status(500).json({ error: 'Failed to create/update file' });
    }
  });

  // Bulk update files (for saving edited files from UI)
  app.post("/api/sessions/:id/files/bulk", validateRequest({ params: sessionIdParams, body: bulkFilesBody }), async (req, res) => {
    try {
      const sessionId = req.params.id;
      const { files } = req.body; // Array of { fileName, content }

      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'files array is required and must not be empty' });
      }

      console.log(`\n📝 Bulk updating ${files.length} file(s) in session ${sessionId}...`);

      // Get existing files for this session
      const existingFiles = await storage.getFilesBySession(sessionId);
      const existingFilesMap = new Map(
        existingFiles.map((f) => [fileBasenameKey(f.fileName), f] as const),
      );

      const results = [];
      let createdCount = 0;
      let updatedCount = 0;

      for (const fileData of files) {
        const { fileName, content } = fileData;

        if (!fileName || content === undefined) {
          console.warn(`⚠️  Skipping invalid file entry: ${JSON.stringify(fileData)}`);
          continue;
        }

        const existingFile = existingFilesMap.get(fileBasenameKey(fileName));

        if (existingFile) {
          // Update existing file
          const updated = await storage.updateFile(existingFile.id, content);
          results.push(updated);
          updatedCount++;
          console.log(`   ✅ Updated: ${fileName} (${content.length} bytes)`);
        } else {
          // Create new file
          const created = await storage.createFile({
            sessionId,
            fileName,
            content,
          });
          existingFilesMap.set(fileBasenameKey(fileName), created);
          results.push(created);
          createdCount++;
          console.log(`   ➕ Created: ${fileName} (${content.length} bytes)`);
        }
      }

      console.log(`✅ Bulk update complete: ${updatedCount} updated, ${createdCount} created`);

      res.json({
        success: true,
        files: results,
        updated: updatedCount,
        created: createdCount,
        total: results.length
      });
    } catch (error) {
      console.error('Error bulk updating files:', error);
      res.status(500).json({ error: 'Failed to bulk update files' });
    }
  });

  // Update a file
  app.patch("/api/files/:id", validateRequest({ params: fileIdParams, body: updateFileBody }), async (req, res) => {
    try {
      const { content } = req.body;
      const file = await storage.updateFile(req.params.id, content);
      res.json(file);
    } catch (error) {
      console.error('Error updating file:', error);
      res.status(500).json({ error: 'Failed to update file' });
    }
  });
}

