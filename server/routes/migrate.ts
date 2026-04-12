import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth';
import {
  fetchResourceGroups,
  fetchAzureResources,
  fetchResourceGroupLocation,
} from '../valuation/resource-fetcher';
import type { AzureResource } from '@shared/schema';
import { openaiService } from '../openai-service';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { sessions } from '@shared/schema';

import { storage } from '../storage';
import { mcpClient } from '../mcp-client';
import { resolveRepositoryCredentials } from '../utils/credentials';
import { bitwardenService } from '../services/bitwarden-service';
import { ensureVariablesTfFromMainTf } from '../terraform-variable-sync';
import {
  isTerraformRootModuleCicdSession,
  TERRAFORM_MODULE_VALIDATE_WORKFLOW,
  TERRAFORM_MODULE_APPLY_WORKFLOW,
} from '../terraform-module-cicd.js';
import {
  ensureContainerAppContainerCpuMemory,
  postProcessMigrateOpsAzurerm4MainTf,
  fixResourceLocationsFromArmData,
  fixImportBlocksQuotedToAddresses,
  fixImportIdsCasing,
  normalizeArmIdCasing,
} from '../migrate-hcl-fixes.js';
import { buildSchemaGuidanceForResources } from '../migrate-schema-guidance.js';
import { enrichAzureResourcesForMigrateOps } from '../migrate-azure-enrichment.js';

const router = Router();

/** GitHub Actions log endpoints can be briefly unavailable while jobs start or finish. */
function isMigrateGitHubLogsTransientError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message || '').toLowerCase();
  return (
    msg.includes('no workflow jobs found yet') ||
    msg.includes('job may still be starting') ||
    msg.includes('did not return a job log url yet') ||
    msg.includes('failed to download workflow logs: 404') ||
    msg.includes('failed to download workflow logs: 302')
  );
}

async function resolveGithubRepoIdentifier(
  repositoryName: string | null,
  repositoryId: string | null,
  credentials: any
): Promise<string> {
  let repoIdentifier = String(repositoryName || repositoryId || '');
  if (repoIdentifier && /^\d+$/.test(String(repoIdentifier))) {
    try {
      const repos = await mcpClient.listRepositories('github', credentials);
      const match = repos.find((r: any) => String(r.id) === String(repoIdentifier));
      repoIdentifier = match?.full_name || match?.name || repoIdentifier;
    } catch {
      // keep original value; downstream call will surface if invalid
    }
  }
  return repoIdentifier;
}

async function syncAzureSecretsToGitHubRepo(
  userId: string,
  repoIdentifier: string,
  credentials: any
): Promise<{ synced: string[] }> {
  let azureSecret: Record<string, string> | null = null;
  try {
    azureSecret = await bitwardenService.getUserSecret(userId, 'azure-cloud');
  } catch {
    // Bitwarden may be unavailable in some deployments; env fallback is handled below.
  }
  const clientId = azureSecret?.clientId || process.env.AZURE_CLIENT_ID || '';
  const tenantId = azureSecret?.tenantId || process.env.AZURE_TENANT_ID || '';
  const subscriptionId = azureSecret?.subscriptionId || process.env.AZURE_SUBSCRIPTION_ID || '';
  const clientSecret = azureSecret?.clientSecret || process.env.AZURE_CLIENT_SECRET || '';

  if (!clientId || !tenantId || !subscriptionId || !clientSecret) {
    throw new Error(
      'Missing Azure Cloud credentials for workflow login. Save azure-cloud secrets in Settings (clientId, tenantId, subscriptionId, clientSecret).'
    );
  }

  return mcpClient.syncGitHubRepositorySecrets(
    repoIdentifier,
    {
      AZURE_CLIENT_ID: clientId,
      AZURE_TENANT_ID: tenantId,
      AZURE_SUBSCRIPTION_ID: subscriptionId,
      AZURE_CLIENT_SECRET: clientSecret,
      AZURE_CREDENTIALS: JSON.stringify({
        clientId,
        clientSecret,
        tenantId,
        subscriptionId,
      }),
      ARM_CLIENT_ID: clientId,
      ARM_CLIENT_SECRET: clientSecret,
      ARM_TENANT_ID: tenantId,
      ARM_SUBSCRIPTION_ID: subscriptionId,
    },
    credentials
  );
}

function extractTerraformResourceAddresses(files: Array<{ fileName: string; content: string }>): Set<string> {
  const addresses = new Set<string>();
  const resourceRegex = /resource\s+"([^"]+)"\s+"([^"]+)"/g;

  for (const file of files) {
    if (!file.fileName.endsWith('.tf')) continue;
    if (file.fileName.toLowerCase() === 'imports.tf') continue;
    resourceRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = resourceRegex.exec(file.content)) !== null) {
      addresses.add(`${match[1]}.${match[2]}`);
    }
  }

  return addresses;
}

function extractImportEntries(importsContent: string): Array<{ to: string; id: string }> {
  const entries: Array<{ to: string; id: string }> = [];
  const importBlockRegex = /import\s*\{([\s\S]*?)\}/g;
  let block: RegExpExecArray | null;

  while ((block = importBlockRegex.exec(importsContent)) !== null) {
    const body = block[1];
    const toMatch = body.match(/to\s*=\s*([^\n\r]+)/);
    const idMatch = body.match(/id\s*=\s*"([^"]+)"/);
    if (toMatch && idMatch) {
      entries.push({
        to: toMatch[1].trim(),
        id: idMatch[1].trim(),
      });
    }
  }

  return entries;
}

/**
 * ARM IDs for resource group(s) the user scoped MigrateOps to (from extract).
 * Azure's "list resources in resource group" inventory does not include the RG resource itself,
 * so sync-check must merge these IDs or azurerm_resource_group imports look falsely "stale".
 */
function migrateScopeResourceGroupArmIds(selectedResourceGroupsJson: string | null | undefined): string[] {
  if (!selectedResourceGroupsJson || typeof selectedResourceGroupsJson !== 'string') return [];
  try {
    const arr = JSON.parse(selectedResourceGroupsJson);
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const item of arr) {
      const s = String(item || '').trim();
      if (!s) continue;
      if (/^\/subscriptions\/[^/]+\/resourceGroups\//i.test(s)) {
        out.push(s);
      }
    }
    return out;
  } catch {
    return [];
  }
}

const PROTECTED_TF_ROOT_NAMES = new Set(['backend.tf', 'provider.tf', 'terraform.tf']);

/** Remove duplicate root `terraform {}` / `provider "azurerm" {}` blocks AI may put in main.tf (conflicts with provider.tf). */
function stripConflictingRootBlocksFromFile(content: string): string {
  let c = content;
  for (let iter = 0; iter < 10; iter++) {
    const before = c.trimStart();
    if (before.startsWith('terraform')) {
      const next = stripFirstHclBlockStartingAtKeyword(before);
      if (next === before) break;
      c = next;
      continue;
    }
    if (/^provider\s+"azurerm"\s*\{/.test(before)) {
      const next = stripFirstHclBlockStartingAtKeyword(before);
      if (next === before) break;
      c = next;
      continue;
    }
    break;
  }
  return c.trimStart();
}

function stripFirstHclBlockStartingAtKeyword(s: string): string {
  const t = s.trimStart();
  const open = t.indexOf('{');
  if (open === -1) return s;
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const ch = t[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return t.slice(i + 1);
      }
    }
  }
  return s;
}

function dedupeMigrateOpsProviderBlocks(
  files: Array<{ path: string; content: string }>
): Array<{ path: string; content: string }> {
  return files.map((f) => {
    const base = f.path.split('/').pop()?.toLowerCase() || '';
    if (!base.endsWith('.tf') || PROTECTED_TF_ROOT_NAMES.has(base)) {
      return f;
    }
    return { path: f.path, content: stripConflictingRootBlocksFromFile(f.content) };
  });
}

function resourceGroupNameFromSelection(resourceGroupId: string): string {
  const s = String(resourceGroupId);
  const m = s.match(/\/resourceGroups\/([^/]+)/i);
  if (m) return m[1];
  return s.trim();
}

function pickDefaultAzureLocation(resources: any[], preferredRgName?: string): string {
  // "global" is not a real Azure region — it appears on action groups, policy assignments, etc.
  const isRealRegion = (loc: string) => loc && loc.toLowerCase() !== 'global';

  // 1. Prefer an embedded Microsoft.Resources/resourceGroups entry (injected at extract from ARM GET)
  //    — listing .../resourceGroups/{name}/resources does NOT return the RG itself.
  for (const r of resources) {
    const t = String(r?.type || '').toLowerCase();
    if (t === 'microsoft.resources/resourcegroups' || t === 'microsoft.resources/subscriptions/resourcegroups') {
      const loc = String(r?.location || '').trim();
      if (isRealRegion(loc)) return loc.toLowerCase().replace(/\s+/g, '');
    }
  }

  // 2. If we know the RG name, find a child resource in that RG with a real location (unordered —
  //    may not match the RG's own region if resources span regions; prefer fetchResourceGroupLocation + stub.)
  if (preferredRgName) {
    const rgLower = preferredRgName.toLowerCase();
    for (const r of resources) {
      const rg = String(r?.resourceGroup || '').toLowerCase();
      const loc = String(r?.location || '').trim();
      if (rg === rgLower && isRealRegion(loc)) return loc.toLowerCase().replace(/\s+/g, '');
    }
  }

  // 3. Fall back to the first resource with a real (non-global) location
  for (const r of resources) {
    const loc = String(r?.location || '').trim();
    if (isRealRegion(loc)) return loc.toLowerCase().replace(/\s+/g, '');
  }

  return 'eastus';
}

function buildMigrateOpsRepairContext(session: {
  scannedResources: string | null;
  selectedResourceGroups: string | null;
}): {
  azureResources: any[];
  schemaGuidanceText: string;
  scopeCtx: string;
  rgName: string;
  rgLocation: string;
} {
  let azureResources: any[] = [];
  try {
    const parsed = session.scannedResources ? JSON.parse(session.scannedResources) : [];
    azureResources = Array.isArray(parsed) ? parsed : [];
  } catch {
    azureResources = [];
  }
  const enriched = enrichAzureResourcesForMigrateOps(azureResources);
  const schemaGuidanceText = buildSchemaGuidanceForResources(enriched);
  let rgIds: string[] = [];
  try {
    const j = session.selectedResourceGroups ? JSON.parse(session.selectedResourceGroups) : [];
    rgIds = Array.isArray(j) ? j.map(String) : [];
  } catch {
    rgIds = [];
  }
  const rgName = rgIds[0] ? resourceGroupNameFromSelection(rgIds[0]) : '';
  const rgLocation = pickDefaultAzureLocation(azureResources, rgName || undefined);
  const locationRefLines: string[] = [];
  for (const r of azureResources) {
    if (r?.name && r?.location) {
      locationRefLines.push(
        `  ${r.name} (${String(r.type || '').toLowerCase()}) → location = "${r.location}"`
      );
    }
  }
  const locationRefSection =
    locationRefLines.length > 0
      ? `\nACTUAL AZURE RESOURCE LOCATIONS (from live ARM data — use these verbatim):\n${locationRefLines.join('\n')}\n`
      : '';
  const scopeCtx =
    rgName && rgLocation
      ? `Scope: resource group "${rgName}" (RG location: "${rgLocation}"). The azurerm_resource_group.migrate_scope block uses location = "${rgLocation}". ALL OTHER resources MUST hardcode their own location string from the ARM data below — do NOT use var.location or "${rgLocation}" for non-RG resources.${locationRefSection}`
      : locationRefSection;
  return { azureResources, schemaGuidanceText, scopeCtx, rgName, rgLocation };
}

/** Body snapshot from UI after commit clears session file storage */
function normalizeTerraformFilesFromRepairBody(
  raw: unknown
): Array<{ path: string; content: string }> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<{ path: string; content: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const path = String(rec.path ?? rec.fileName ?? '').trim();
    const content = rec.content;
    if (!path || typeof content !== 'string') continue;
    out.push({ path, content });
  }
  return out.length ? out : null;
}

/**
 * Structural post-processing only: ensure the root resource group block exists
 * and inject live ARM container cpu/memory values.
 * Schema-level fixes (attribute renames, removed blocks) are handled by the AI repair pass.
 */
function postProcessMigrateOpsMainTf(
  content: string,
  ctx: { resourceGroupName: string; location: string },
  azureResources?: any[]
): string {
  let c = content;
  const hasRgResource = /resource\s+"azurerm_resource_group"\s+"/m.test(c);
  if (!hasRgResource && ctx.resourceGroupName) {
    c = `resource "azurerm_resource_group" "migrate_scope" {
  name     = "${ctx.resourceGroupName}"
  location = "${ctx.location}"
}

` + c;
  }

  // Deterministically fix any azurerm_resource_group block that has location = "global"
  // or any variable reference — the RG location must always be ctx.location.
  if (ctx.location && ctx.location !== 'global') {
    c = c.replace(
      /(resource\s+"azurerm_resource_group"\s+"[^"]+"\s*\{[^}]*?\blocation\s*=\s*)"global"(\s)/g,
      `$1"${ctx.location}"$2`
    );
  }
  c = c.replace(/azurerm_resource_group\.[a-zA-Z_][a-zA-Z0-9_]*\.(name|id)\b/g, 'azurerm_resource_group.migrate_scope.$1');
  c = postProcessMigrateOpsAzurerm4MainTf(c, azureResources);   // comprehensive deterministic attribute fixes + ARM-derived ports
  c = ensureContainerAppContainerCpuMemory(c, azureResources);
  c = fixResourceLocationsFromArmData(c, azureResources || []);
  return c;
}

function ensureImportsFile(
  generatedFiles: Array<{ path: string; content: string }>,
  azureResources: any[]
): Array<{ path: string; content: string }> {
  const normalized = [...generatedFiles];
  const terraformResources = Array.from(
    extractTerraformResourceAddresses(
      normalized.map((f) => ({ fileName: f.path, content: f.content }))
    )
  );

  if (terraformResources.length === 0) {
    return normalized;
  }

  const importsIndex = normalized.findIndex((f) => f.path.toLowerCase() === 'imports.tf');
  const existingImports = importsIndex >= 0 ? extractImportEntries(normalized[importsIndex].content) : [];
  const existingToSet = new Set(existingImports.map((e) => e.to));

  const liveIds = azureResources
    .map((r: any) => normalizeArmIdCasing(String(r?.id || '').trim()))
    .filter((id: string) => id.length > 0);

  let nextIdIndex = 0;
  const addedBlocks: string[] = [];

  for (const address of terraformResources) {
    if (existingToSet.has(address)) continue;
    if (nextIdIndex >= liveIds.length) break;
    const id = liveIds[nextIdIndex++];
    addedBlocks.push(
      `import {\n  to = ${address}\n  id = "${id}"\n}`
    );
  }

  if (addedBlocks.length === 0) {
    return normalized;
  }

  const header = "# Auto-generated fallback imports by MigrateOps.\n# Review and adjust mapping before terraform apply.\n\n";
  if (importsIndex >= 0) {
    const existing = normalized[importsIndex].content.trim();
    normalized[importsIndex] = {
      path: normalized[importsIndex].path,
      content: `${existing}\n\n${addedBlocks.join('\n\n')}\n`,
    };
  } else {
    normalized.push({
      path: 'imports.tf',
      content: `${header}${addedBlocks.join('\n\n')}\n`,
    });
  }

  return normalized;
}

// GET /api/migrate/azure/resource-groups
// List available resource groups from the user's Azure subscription
router.get('/azure/resource-groups', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const resourceGroups = await fetchResourceGroups(req.userId);
    res.json(resourceGroups);
  } catch (error: any) {
    console.error('Failed to fetch resource groups:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch resource groups' });
  }
});

// POST /api/migrate/extract
// Extract live resources from a resource group and reverse-engineer into HCL
router.post('/extract', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId, resourceGroupId, cloudProvider = 'azure' } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    
    if (cloudProvider !== 'azure') {
       return res.status(400).json({ error: 'Only azure is supported for MigrateOps currently.' });
    }

    if (!resourceGroupId) {
      return res.status(400).json({ error: 'resourceGroupId is required for extraction' });
    }

    // 1. Fetch live resources from Azure for the specific resource group
    console.log(`[MigrateOps] Fetching live Azure resources for resourceGroupId: ${resourceGroupId}`);
    const azureResources = await fetchAzureResources(req.userId, [resourceGroupId]);
    
    if (!azureResources || azureResources.length === 0) {
      return res.status(404).json({ error: 'No resources found in the specified resource group' });
    }

    const enrichedResources = enrichAzureResourcesForMigrateOps(azureResources as any[]);

    // 2. Translate JSON to HCL using OpenAI (scoped to this resource group; azurerm-accurate types)
    const rgName = resourceGroupNameFromSelection(resourceGroupId);
    const subscriptionIdFromRgId =
      String(resourceGroupId).match(/\/subscriptions\/([^/]+)\//i)?.[1] ||
      String(process.env.AZURE_SUBSCRIPTION_ID || '').trim();

    let rgLocationFromArm: string | null = null;
    if (subscriptionIdFromRgId && rgName) {
      rgLocationFromArm = await fetchResourceGroupLocation(
        req.userId,
        subscriptionIdFromRgId,
        rgName
      );
    }
    const rgLocation =
      rgLocationFromArm || pickDefaultAzureLocation(azureResources as any[], rgName);
    if (rgLocationFromArm) {
      console.log(`[MigrateOps] Resource group location from ARM: ${rgLocationFromArm}`);
    } else {
      console.warn(
        `[MigrateOps] Using inferred RG location (no ARM metadata): ${rgLocation} — re-run extract after deploy if this looks wrong.`
      );
    }
    console.log(`[MigrateOps] Translating ${azureResources.length} resources to Terraform HCL (rg=${rgName}, location=${rgLocation})...`);
    const result = await openaiService.generateTerraformFromLiveState(cloudProvider, enrichedResources, {
      resourceGroupName: rgName,
      resourceGroupLocation: rgLocation,
    });

    // Structural post-processing (RG stub + live container cpu/memory)
    let files = (result.files || []).map((f) => {
      const base = f.path.split('/').pop()?.toLowerCase() || '';
      if (base !== 'main.tf') return f;
      return {
        path: f.path,
        content: postProcessMigrateOpsMainTf(f.content, { resourceGroupName: rgName, location: rgLocation }, azureResources),
      };
    });

    // AI repair pass: feed the schema guidance back and let AI fix any attribute/block issues
    const schemaGuidanceText = buildSchemaGuidanceForResources(enrichedResources as any[]);

    // Build a location reference map so the repair AI can fix var.location usages
    const locationRefLines: string[] = [];
    for (const r of azureResources as any[]) {
      if (r?.name && r?.location) {
        locationRefLines.push(`  ${r.name} (${String(r.type || '').toLowerCase()}) → location = "${r.location}"`);
      }
    }
    const locationRefSection = locationRefLines.length > 0
      ? `\nACTUAL AZURE RESOURCE LOCATIONS (from live ARM data — use these verbatim):\n${locationRefLines.join('\n')}\n`
      : '';

    const scopeCtx = rgName && rgLocation
      ? `Scope: resource group "${rgName}" (RG location: "${rgLocation}"). The azurerm_resource_group.migrate_scope block uses location = "${rgLocation}". ALL OTHER resources MUST hardcode their own location string from the ARM data below — do NOT use var.location or "${rgLocation}" for non-RG resources.${locationRefSection}`
      : locationRefSection;
    files = await openaiService.repairMigrateOpsFiles(files, schemaGuidanceText, scopeCtx);

    let filesWithImports = ensureImportsFile(files, azureResources);
    filesWithImports = dedupeMigrateOpsProviderBlocks(filesWithImports);
    filesWithImports = filesWithImports.map((f) => {
      if (f.path.toLowerCase() === 'imports.tf') {
        let c = fixImportBlocksQuotedToAddresses(f.content);
        c = fixImportIdsCasing(c);
        return { path: f.path, content: c };
      }
      return f;
    });

    // 3. Save generated files to the session
    console.log(`[MigrateOps] Saving generated files to session ${sessionId}...`);
    
    // First, verify the session exists and belongs to the user
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const rgArmId =
      subscriptionIdFromRgId && rgName
        ? `/subscriptions/${subscriptionIdFromRgId}/resourceGroups/${rgName}`
        : '';
    const resourceGroupStub: AzureResource | null = rgArmId
      ? {
          id: rgArmId,
          name: rgName,
          type: 'Microsoft.Resources/resourceGroups',
          location: rgLocation,
          resourceGroup: rgName,
          sku: '',
          tier: '',
          properties: {},
          actualCostMTD: 0,
        }
      : null;
    const scannedResourcesForSession: AzureResource[] = resourceGroupStub
      ? [resourceGroupStub, ...azureResources]
      : [...azureResources];

    // Save to session
    await db.update(sessions)
      .set({
        activeModule: 'migrateops',
        cloudProvider: cloudProvider as any,
        scannedResources: JSON.stringify(scannedResourcesForSession),
        selectedResourceGroups: JSON.stringify([resourceGroupId]),
        scanTimestamp: new Date().toISOString(),
        hasBackend: 'false',
        backendType: null, // Will be configured in commit phase
      })
      .where(eq(sessions.id, sessionId));

    // Also save to the files table so that pipeline stages (like Refactor, Diagram, Security, Cost) can find them
    await storage.deleteFilesBySession(sessionId);
    for (const f of filesWithImports) {
      await storage.createFile({
        sessionId,
        fileName: f.path,
        content: f.content,
      });
    }

    await ensureVariablesTfFromMainTf(sessionId);

    const persisted = await storage.getFilesBySession(sessionId);
    const filesOut = persisted.map((f) => ({ path: f.fileName, content: f.content }));

    res.json({
      message: 'Successfully extracted and translated resources',
      files: filesOut,
      resourceCount: azureResources.length
    });

  } catch (error: any) {
    console.error('Failed to extract resources:', error);
    res.status(500).json({ error: error.message || 'Failed to extract resources' });
  }
});

// POST /api/migrate/sync-check
// Validate that generated Terraform/import mapping still aligns with discovered Azure resources
router.post('/sync-check', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const files = await storage.getFilesBySession(sessionId);
    const terraformResources = extractTerraformResourceAddresses(files);
    const importsFile = files.find((f) => f.fileName.toLowerCase() === 'imports.tf');
    const importEntries = importsFile ? extractImportEntries(importsFile.content) : [];
    const importToSet = new Set(importEntries.map((e) => e.to));

    const missingImports = Array.from(terraformResources).filter((addr) => !importToSet.has(addr));
    const orphanImports = importEntries.filter((e) => !terraformResources.has(e.to)).map((e) => e.to);

    let staleImports: Array<{ to: string; id: string }> = [];
    if (session.scannedResources) {
      try {
        const scanned = JSON.parse(session.scannedResources as string);
        if (Array.isArray(scanned)) {
          const liveIds = new Set(
            scanned
              .map((r: any) => String(r?.id || '').trim().toLowerCase())
              .filter((id: string) => id.length > 0)
          );
          for (const rgArmId of migrateScopeResourceGroupArmIds(session.selectedResourceGroups as string | null)) {
            liveIds.add(rgArmId.trim().toLowerCase());
          }
          staleImports = importEntries.filter((e) => !liveIds.has(e.id.toLowerCase()));
        }
      } catch {
        // Ignore parse issues; sync check still works for import/resource parity
      }
    }

    const isInSync =
      missingImports.length === 0 && staleImports.length === 0 && orphanImports.length === 0;
    const warnings: string[] = [
      "MigrateOps fidelity warning: even a small Terraform argument change can force resource replacement.",
      "Always run terraform plan and review `forces replacement` actions before apply.",
    ];
    if (missingImports.length > 0) {
      warnings.push(`Found ${missingImports.length} resource(s) without import mapping.`);
    }
    if (staleImports.length > 0) {
      warnings.push(`Found ${staleImports.length} import ID(s) that do not match currently discovered Azure resource IDs.`);
    }
    if (orphanImports.length > 0) {
      warnings.push(
        `Found ${orphanImports.length} import block(s) whose "to" address does not match any resource block in main.tf.`
      );
    }

    let aiRemediation: Awaited<ReturnType<typeof openaiService.generateMigrateSyncRemediation>> = null;
    const syncAiEnabled = process.env.MIGRATEOPS_SYNC_AI !== '0';
    if (!isInSync && syncAiEnabled) {
      try {
        aiRemediation = await openaiService.generateMigrateSyncRemediation({
          missingImports,
          staleImports,
          orphanImports,
          terraformResourceCount: terraformResources.size,
          importBlockCount: importEntries.length,
        });
      } catch (remErr: any) {
        console.warn('Migrate sync AI remediation skipped:', remErr?.message || remErr);
      }
    }

    return res.json({
      success: true,
      summary: {
        status: isInSync ? 'in_sync' : 'out_of_sync',
        terraformResourceCount: terraformResources.size,
        importBlockCount: importEntries.length,
        missingImportCount: missingImports.length,
        staleImportCount: staleImports.length,
        orphanImportCount: orphanImports.length,
      },
      details: {
        missingImports,
        staleImports,
        orphanImports,
      },
      warnings,
      aiRemediation,
    });
  } catch (error: any) {
    console.error('Failed to run migrate sync check:', error);
    return res.status(500).json({ error: error.message || 'Failed to run migrate sync check' });
  }
});

// GET /api/migrate/cicd/preflight
// Validate repository/workflow/secrets readiness before running Validate Migration workflow
router.get('/cicd/preflight', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = String(req.query.sessionId || '');
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.provider !== 'github' || (!session.repositoryName && !session.repositoryId)) {
      return res.status(400).json({ error: 'Pre-flight check is available only for GitHub repositories' });
    }

    const checks = {
      githubCredentials: false,
      repositoryResolved: false,
      validateWorkflowPresent: false,
      azureCredentialsAvailable: false,
      githubSecretsWritable: false,
    };
    const issues: string[] = [];

    const { credentials, reason } = await resolveRepositoryCredentials('github', req.userId);
    const githubToken = credentials?.github?.token || process.env.GITHUB_TOKEN || '';
    if (!githubToken) {
      issues.push(reason || 'GitHub token not found. Save GitHub credentials in Settings (Bitwarden) or set GITHUB_TOKEN.');
    } else {
      checks.githubCredentials = true;
    }

    const repoIdentifier = await resolveGithubRepoIdentifier(
      session.repositoryName,
      session.repositoryId,
      credentials
    );
    if (!repoIdentifier) {
      issues.push('Could not resolve GitHub repository identifier from session.');
    } else {
      checks.repositoryResolved = true;
    }

    const branch = session.repositoryBranch || 'main';
    const validateWorkflowPath = isTerraformRootModuleCicdSession(session)
      ? `.github/workflows/${TERRAFORM_MODULE_VALIDATE_WORKFLOW}`
      : '.github/workflows/migrateops-validate.yml';
    if (checks.repositoryResolved) {
      try {
        await mcpClient.getRepositoryFile(
          'github',
          repoIdentifier,
          validateWorkflowPath,
          branch,
          credentials
        );
        checks.validateWorkflowPresent = true;
      } catch (wfErr: any) {
        const isEmptyRepo =
          wfErr?.status === 409 ||
          wfErr?.message?.includes('Git Repository is empty') ||
          wfErr?.message?.includes('This repository is empty');
        if (isEmptyRepo) {
          // Repo was just created and will be populated on commit — treat as ready
          checks.validateWorkflowPresent = true;
        } else {
          issues.push(
            `Missing ${validateWorkflowPath} on target branch. Commit workflow files first or ensure the GitHub token has workflow scope.`
          );
        }
      }
    }

    let azureSecret: Record<string, string> | null = null;
    try {
      azureSecret = await bitwardenService.getUserSecret(req.userId!, 'azure-cloud');
    } catch {
      // Bitwarden can be unavailable; env fallback below.
    }
    const clientId = azureSecret?.clientId || process.env.AZURE_CLIENT_ID || '';
    const clientSecret = azureSecret?.clientSecret || process.env.AZURE_CLIENT_SECRET || '';
    const tenantId = azureSecret?.tenantId || process.env.AZURE_TENANT_ID || '';
    const subscriptionId = azureSecret?.subscriptionId || process.env.AZURE_SUBSCRIPTION_ID || '';
    if (!clientId || !clientSecret || !tenantId || !subscriptionId) {
      issues.push(
        'Azure cloud credentials are incomplete. Required: clientId, clientSecret, tenantId, subscriptionId (Bitwarden azure-cloud or server env).'
      );
    } else {
      checks.azureCredentialsAvailable = true;
    }

    if (checks.githubCredentials && checks.repositoryResolved) {
      try {
        await mcpClient.syncGitHubRepositorySecrets(
          repoIdentifier,
          { SPIRITOPS_PREFLIGHT_CHECK: new Date().toISOString() },
          credentials
        );
        checks.githubSecretsWritable = true;
      } catch (secretErr: any) {
        issues.push(
          `Cannot write GitHub repository secrets. Ensure token has Actions/Secrets write permission (${secretErr?.message || 'unknown error'}).`
        );
      }
    }

    const ready = Object.values(checks).every(Boolean);
    return res.json({
      success: true,
      ready,
      checks,
      issues,
      repository: repoIdentifier,
      branch,
    });
  } catch (error: any) {
    console.error('Failed to run migrate pre-flight check:', error);
    return res.status(500).json({ error: error.message || 'Failed to run pre-flight check' });
  }
});

// POST /api/migrate/cicd/start-validate
// Trigger GitHub Actions validate workflow for migration
router.post('/cicd/start-validate', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId, branch } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.provider !== 'github' || (!session.repositoryName && !session.repositoryId)) {
      return res.status(400).json({ error: 'Validate workflow dispatch is available only for GitHub repositories' });
    }

    const { credentials } = await resolveRepositoryCredentials('github', req.userId);
    const repoIdentifier = await resolveGithubRepoIdentifier(
      session.repositoryName,
      session.repositoryId,
      credentials
    );
    const targetBranch = branch || session.repositoryBranch || 'main';
    const validateWorkflowFile = isTerraformRootModuleCicdSession(session)
      ? TERRAFORM_MODULE_VALIDATE_WORKFLOW
      : 'migrateops-validate.yml';
    const validateWorkflowPath = `.github/workflows/${validateWorkflowFile}`;
    // Check workflow file presence — but allow empty repos (file will have been committed by commit step)
    try {
      await mcpClient.getRepositoryFile(
        'github',
        repoIdentifier,
        validateWorkflowPath,
        targetBranch,
        credentials
      );
    } catch (wfErr: any) {
      const isEmptyRepo =
        wfErr?.status === 409 ||
        wfErr?.message?.includes('Git Repository is empty') ||
        wfErr?.message?.includes('This repository is empty');
      if (!isEmptyRepo) {
        return res.status(400).json({
          error: 'Validate workflow file not found in repository. Commit the files first and ensure the GitHub token has workflow scope.',
        });
      }
    }
    const secretSync = await syncAzureSecretsToGitHubRepo(req.userId!, repoIdentifier, credentials);
    await mcpClient.triggerGitHubWorkflow(
      repoIdentifier,
      validateWorkflowFile,
      targetBranch,
      undefined,
      credentials
    );

    let run: any | null = null;
    for (let i = 0; i < 5; i++) {
      run = await mcpClient.getLatestGitHubWorkflowRun(
        repoIdentifier,
        validateWorkflowFile,
        targetBranch,
        credentials
      );
      if (run) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    return res.json({
      success: true,
      workflow: validateWorkflowFile,
      branch: targetBranch,
      secretSync,
      runId: run?.id || null,
      runUrl: run?.html_url || null,
      status: run?.status || 'queued',
    });
  } catch (error: any) {
    console.error('Failed to trigger migrate validate workflow:', error);
    return res.status(500).json({ error: error.message || 'Failed to trigger validate workflow' });
  }
});

// POST /api/migrate/cicd/start-apply
// Trigger GitHub Actions apply workflow (approval gate remains in GitHub environment)
router.post('/cicd/start-apply', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId, branch } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.provider !== 'github' || (!session.repositoryName && !session.repositoryId)) {
      return res.status(400).json({ error: 'Apply workflow dispatch is available only for GitHub repositories' });
    }

    const { credentials } = await resolveRepositoryCredentials('github', req.userId);
    const repoIdentifier = await resolveGithubRepoIdentifier(
      session.repositoryName,
      session.repositoryId,
      credentials
    );
    const targetBranch = branch || session.repositoryBranch || 'main';
    const applyWorkflowFile = isTerraformRootModuleCicdSession(session)
      ? TERRAFORM_MODULE_APPLY_WORKFLOW
      : 'migrateops-apply.yml';
    const applyWorkflowPath = `.github/workflows/${applyWorkflowFile}`;
    try {
      await mcpClient.getRepositoryFile(
        'github',
        repoIdentifier,
        applyWorkflowPath,
        targetBranch,
        credentials
      );
    } catch (wfErr: any) {
      const isEmptyRepo =
        wfErr?.status === 409 ||
        wfErr?.message?.includes('Git Repository is empty') ||
        wfErr?.message?.includes('This repository is empty');
      if (!isEmptyRepo) {
        return res.status(400).json({
          error: 'Apply workflow file not found in repository. Commit the files first and ensure the GitHub token has workflow scope.',
        });
      }
    }
    await mcpClient.triggerGitHubWorkflow(
      repoIdentifier,
      applyWorkflowFile,
      targetBranch,
      undefined,
      credentials
    );

    let run: any | null = null;
    for (let i = 0; i < 5; i++) {
      run = await mcpClient.getLatestGitHubWorkflowRun(
        repoIdentifier,
        applyWorkflowFile,
        targetBranch,
        credentials
      );
      if (run) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    return res.json({
      success: true,
      workflow: applyWorkflowFile,
      branch: targetBranch,
      runId: run?.id || null,
      runUrl: run?.html_url || null,
      status: run?.status || 'queued',
    });
  } catch (error: any) {
    console.error('Failed to trigger migrate apply workflow:', error);
    return res.status(500).json({ error: error.message || 'Failed to trigger apply workflow' });
  }
});

// GET /api/migrate/cicd/run-status
// Fetch GitHub Actions workflow run details (status, jobs, steps, artifacts)
router.get('/cicd/run-status', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = String(req.query.sessionId || '');
    const runIdRaw = String(req.query.runId || '');
    if (!sessionId || !runIdRaw) {
      return res.status(400).json({ error: 'sessionId and runId are required' });
    }
    const runId = Number(runIdRaw);
    if (!Number.isFinite(runId)) {
      return res.status(400).json({ error: 'runId must be a number' });
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.provider !== 'github' || (!session.repositoryName && !session.repositoryId)) {
      return res.status(400).json({ error: 'Run status endpoint is available only for GitHub repositories' });
    }

    const { credentials } = await resolveRepositoryCredentials('github', req.userId);
    const repoIdentifier = await resolveGithubRepoIdentifier(
      session.repositoryName,
      session.repositoryId,
      credentials
    );
    const details = await mcpClient.getGitHubWorkflowRunDetails(
      repoIdentifier,
      runId,
      credentials
    );

    return res.json({ success: true, ...details });
  } catch (error: any) {
    console.error('Failed to fetch migrate workflow run status:', error);
    return res.status(500).json({ error: error.message || 'Failed to fetch workflow run status' });
  }
});

// GET /api/migrate/cicd/plan-logs
// Fetch Terraform plan job logs for a workflow run
router.get('/cicd/plan-logs', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sessionId = String(req.query.sessionId || '');
    const runIdRaw = String(req.query.runId || '');
    if (!sessionId || !runIdRaw) {
      return res.status(400).json({ error: 'sessionId and runId are required' });
    }
    const runId = Number(runIdRaw);
    if (!Number.isFinite(runId)) {
      return res.status(400).json({ error: 'runId must be a number' });
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.provider !== 'github' || (!session.repositoryName && !session.repositoryId)) {
      return res.status(400).json({ error: 'Plan logs endpoint is available only for GitHub repositories' });
    }

    const { credentials } = await resolveRepositoryCredentials('github', req.userId);
    const repoIdentifier = await resolveGithubRepoIdentifier(
      session.repositoryName,
      session.repositoryId,
      credentials
    );
    const details = await mcpClient.getGitHubWorkflowPlanLogs(
      repoIdentifier,
      runId,
      credentials
    );

    return res.json({ success: true, ready: true, ...details });
  } catch (error: any) {
    console.error('Failed to fetch migrate workflow plan logs:', error);
    const msg = String(error?.message || '');

    // GitHub Actions logs can be briefly unavailable while the run/job is starting.
    // Return 200 so the UI can keep polling/retrying without surfacing a hard 500.
    if (isMigrateGitHubLogsTransientError(error)) {
      return res.json({
        success: false,
        ready: false,
        retryable: true,
        error: 'Plan logs are not ready yet. Please retry in a few seconds.',
      });
    }

    return res.status(500).json({ error: msg || 'Failed to fetch plan logs' });
  }
});

// POST /api/migrate/cicd/repair-from-logs
// AI repair using GitHub Actions terraform plan output, then persist files for re-commit.
router.post('/cicd/repair-from-logs', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = req.body as {
      sessionId?: string;
      runId?: number | string;
      planLogs?: string;
      terraformFiles?: unknown;
    };
    const sessionId = String(body?.sessionId || '').trim();
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ error: 'Session not found' });
    }

    if (!session.activeModule) {
      await storage.updateSession(sessionId, { activeModule: 'migrateops' });
    }

    const storedFiles = await storage.getFilesBySession(sessionId);
    const fromBody = normalizeTerraformFilesFromRepairBody(body.terraformFiles);
    if (!storedFiles.length && !fromBody) {
      return res.status(400).json({
        error:
          'No Terraform files available. After commit, workspace files are sent from the browser — refresh the MigrateOps page and try again, or run Extract again.',
      });
    }

    let ciLogs = typeof body.planLogs === 'string' ? body.planLogs : '';
    const runIdRaw = body.runId;
    const runId =
      runIdRaw !== undefined && runIdRaw !== null && runIdRaw !== ''
        ? Number(runIdRaw)
        : NaN;

    if (!ciLogs.trim() && Number.isFinite(runId)) {
      if (session.provider !== 'github' || (!session.repositoryName && !session.repositoryId)) {
        return res.status(400).json({
          error:
            'Paste plan logs in planLogs, or use a GitHub-linked session so runId can fetch logs automatically.',
        });
      }
      const { credentials } = await resolveRepositoryCredentials('github', req.userId!);
      const repoIdentifier = await resolveGithubRepoIdentifier(
        session.repositoryName,
        session.repositoryId,
        credentials
      );
      try {
        const logResult = await mcpClient.getGitHubWorkflowPlanLogs(repoIdentifier, runId, credentials);
        ciLogs = logResult.logs || '';
      } catch (fetchErr: unknown) {
        if (isMigrateGitHubLogsTransientError(fetchErr)) {
          return res.status(200).json({
            success: false,
            ready: false,
            retryable: true,
            error: 'CI logs are not ready yet. Please retry in a few seconds.',
          });
        }
        throw fetchErr;
      }
    }

    if (!ciLogs.trim()) {
      return res.status(400).json({
        error:
          'No CI logs to repair from. Open "View Plan Logs" first, or pass planLogs / runId in the request body.',
      });
    }

    const ctx = buildMigrateOpsRepairContext(session);
    let files: Array<{ path: string; content: string }> =
      storedFiles.length > 0
        ? storedFiles.map((f) => ({ path: f.fileName, content: f.content }))
        : fromBody!;

    const hasMain = files.some((f) => f.path.toLowerCase() === 'main.tf');

    files = await openaiService.repairMigrateOpsFiles(
      files,
      ctx.schemaGuidanceText,
      ctx.scopeCtx,
      ciLogs
    );

    // Deterministic post-processing AFTER AI repair — safety net for attribute renames, locations, cpu/memory
    if (hasMain && ctx.rgName && ctx.rgLocation) {
      files = files.map((f) =>
        f.path.toLowerCase() === 'main.tf'
          ? {
              path: f.path,
              content: postProcessMigrateOpsMainTf(
                f.content,
                { resourceGroupName: ctx.rgName, location: ctx.rgLocation },
                ctx.azureResources
              ),
            }
          : f
      );
    }

    files = dedupeMigrateOpsProviderBlocks(files);
    files = files.map((f) => {
      if (f.path.toLowerCase() === 'imports.tf') {
        let c = fixImportBlocksQuotedToAddresses(f.content);
        c = fixImportIdsCasing(c);
        return { path: f.path, content: c };
      }
      return f;
    });

    await ensureVariablesTfFromMainTf(sessionId);

    const existing = await storage.getFilesBySession(sessionId);
    const byName = new Map(existing.map((f) => [f.fileName, f]));
    for (const f of files) {
      const prev = byName.get(f.path);
      if (prev) {
        await storage.updateFile(prev.id, f.content);
      } else {
        const created = await storage.createFile({
          sessionId,
          fileName: f.path,
          content: f.content,
        });
        byName.set(f.path, created);
      }
    }

    const persisted = await storage.getFilesBySession(sessionId);
    const terraformFiles = persisted.map((f) => ({ path: f.fileName, content: f.content }));

    return res.json({
      success: true,
      message: 'Terraform files updated from CI repair. Commit again to re-run validation.',
      terraformFiles,
    });
  } catch (error: any) {
    console.error('Failed MigrateOps CI repair:', error);
    return res.status(500).json({ error: error.message || 'CI repair failed' });
  }
});

export function registerMigrateRoutes(app: any) {
  app.use('/api/migrate', router);
}
