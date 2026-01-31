/**
 * Migration Script: Convert YAML Templates to Fix Snippets
 * 
 * This script migrates existing YAML remediation templates to the new
 * fix snippet storage system.
 */

import { loadTemplatesFromDirectory } from '../rag/template-loader';
import { fixSnippetStore, type FixSnippet } from '../rag/fix-snippet-store';
import { createHash } from 'crypto';

/**
 * Detect cloud provider from check ID
 */
function detectCloudProvider(checkId: string): string {
  if (checkId.includes('AZURE')) return 'azure';
  if (checkId.includes('AWS')) return 'aws';
  if (checkId.includes('GCP')) return 'gcp';
  return 'azure'; // Default
}

/**
 * Generate ID from checkId and resourceType
 */
function generateId(checkId: string, resourceType: string): string {
  const key = `${checkId}:${resourceType}`;
  return createHash('sha256').update(key).digest('hex').substring(0, 16);
}

/**
 * Migrate templates to fix snippets
 */
async function migrateTemplates(): Promise<void> {
  console.log('🔄 Starting template migration...\n');

  // Load existing templates
  const templates = await loadTemplatesFromDirectory();
  console.log(`📁 Found ${templates.length} template(s) to migrate\n`);

  if (templates.length === 0) {
    console.log('⚠️  No templates found. Nothing to migrate.');
    return;
  }

  // Load fix snippet store
  await fixSnippetStore.loadFromDisk();

  let migrated = 0;
  let skipped = 0;
  const errors: string[] = [];

  // Migrate each template
  for (const template of templates) {
    try {
      // Get primary resource type
      const resourceType = template.resource_types[0];
      if (!resourceType) {
        console.warn(`⚠️  Skipping ${template.check_id}: No resource type`);
        skipped++;
        continue;
      }

      // Check if already migrated
      const existing = await fixSnippetStore.getByKey(template.check_id, resourceType);
      if (existing) {
        console.log(`⏭️  Skipping ${template.check_id}: Already exists`);
        skipped++;
        continue;
      }

      // Create fix snippet
      const snippet: FixSnippet = {
        id: generateId(template.check_id, resourceType),
        checkId: template.check_id,
        resourceType: resourceType,
        cloudProvider: detectCloudProvider(template.check_id),
        fixSnippet: template.remediation_snippet,
        context: template.complete_example,
        guideline: template.description || template.check_name,
        source: 'human', // Existing templates are human-created
        confidence: 1.0, // High confidence (tested templates)
        successCount: 0,
        failureCount: 0,
        verified: true, // Mark as verified (they're tested templates)
        deprecated: false,
        lastUsed: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Store snippet
      await fixSnippetStore.store(snippet);
      console.log(`✅ Migrated: ${template.check_id} → ${resourceType}`);
      migrated++;

    } catch (error: any) {
      const errorMsg = `Failed to migrate ${template.check_id}: ${error.message}`;
      console.error(`❌ ${errorMsg}`);
      errors.push(errorMsg);
    }
  }

  // Save to disk
  await fixSnippetStore.saveToDisk();

  // Print summary
  console.log('\n📊 Migration Summary:');
  console.log(`   ✅ Migrated: ${migrated}`);
  console.log(`   ⏭️  Skipped: ${skipped}`);
  console.log(`   ❌ Errors: ${errors.length}`);

  if (errors.length > 0) {
    console.log('\n❌ Errors:');
    errors.forEach(err => console.log(`   - ${err}`));
  }

  // Print statistics
  const stats = fixSnippetStore.getStats();
  console.log('\n📈 Fix Snippet Store Statistics:');
  console.log(`   Total: ${stats.total}`);
  console.log(`   Active: ${stats.active}`);
  console.log(`   Deprecated: ${stats.deprecated}`);
  console.log(`   By Source: ${JSON.stringify(stats.bySource, null, 2)}`);
  console.log(`   By Cloud Provider: ${JSON.stringify(stats.byCloudProvider, null, 2)}`);

  console.log('\n✅ Migration complete!');
}

// Run migration if called directly
migrateTemplates()
  .then(() => {
    console.log('\n🎉 Migration script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration script failed:', error);
    process.exit(1);
  });

export { migrateTemplates };

