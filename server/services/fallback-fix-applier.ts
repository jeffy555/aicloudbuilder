/**
 * Fallback Fix Applier
 *
 * Applies security fixes directly without AI when OpenAI quota is exceeded.
 * Uses pattern matching and direct snippet injection for common security fixes.
 */

import * as yaml from 'js-yaml';

interface FixApplication {
  checkId: string;
  fix: string;
  resourceName?: string;
  resourceKind?: string;
}

interface ApplyResult {
  success: boolean;
  content: string;
  appliedFixes: string[];
  failedFixes: string[];
  error?: string;
}

/**
 * Apply Kubernetes security fixes directly to YAML content
 */
export function applyKubernetesFixes(
  content: string,
  fixes: FixApplication[]
): ApplyResult {
  const appliedFixes: string[] = [];
  const failedFixes: string[] = [];

  try {
    // Parse all YAML documents
    const docs = yaml.loadAll(content) as any[];

    for (const fix of fixes) {
      if (!fix.fix) {
        failedFixes.push(`${fix.checkId}: No fix snippet provided`);
        continue;
      }

      try {
        // Parse the fix snippet
        const fixSnippet = yaml.load(fix.fix) as any;

        // Find the target document by kind and name
        const targetDoc = docs.find(doc => {
          if (!doc || !doc.kind) return false;

          // Match by kind
          if (fix.resourceKind && doc.kind !== fix.resourceKind) return false;

          // Match by name if provided (e.g., "Deployment.app-name")
          if (fix.resourceName) {
            const nameParts = fix.resourceName.split('.');
            const expectedName = nameParts.length > 1 ? nameParts[1] : nameParts[0];
            if (doc.metadata?.name && doc.metadata.name !== expectedName) return false;
          }

          return true;
        });

        if (targetDoc) {
          // Apply fix based on what the snippet contains
          applyFixToDocument(targetDoc, fixSnippet, fix.checkId);
          appliedFixes.push(fix.checkId);
        } else if (docs.length === 1) {
          // Only one document, apply to it
          applyFixToDocument(docs[0], fixSnippet, fix.checkId);
          appliedFixes.push(fix.checkId);
        } else {
          failedFixes.push(`${fix.checkId}: Could not find target resource`);
        }
      } catch (parseErr: any) {
        failedFixes.push(`${fix.checkId}: Failed to parse fix - ${parseErr.message}`);
      }
    }

    // Serialize back to YAML
    const resultContent = docs
      .map(doc => yaml.dump(doc, { lineWidth: -1, noRefs: true }))
      .join('---\n');

    return {
      success: appliedFixes.length > 0,
      content: resultContent,
      appliedFixes,
      failedFixes
    };
  } catch (err: any) {
    return {
      success: false,
      content,
      appliedFixes: [],
      failedFixes: fixes.map(f => `${f.checkId}: YAML parse error`),
      error: `Failed to parse YAML: ${err.message}`
    };
  }
}

/**
 * Deep merge fix snippet into target document
 */
function applyFixToDocument(doc: any, fixSnippet: any, checkId: string): void {
  // Handle common Kubernetes security contexts
  if (fixSnippet.securityContext) {
    // Apply to spec.securityContext (pod-level)
    if (doc.spec) {
      doc.spec.securityContext = deepMerge(
        doc.spec.securityContext || {},
        fixSnippet.securityContext
      );
    }
  }

  if (fixSnippet.containers || fixSnippet.spec?.containers) {
    const containerFix = fixSnippet.containers || fixSnippet.spec?.containers;
    // Apply to containers in spec
    const containers = doc.spec?.containers || doc.spec?.template?.spec?.containers;
    if (containers && Array.isArray(containers) && Array.isArray(containerFix)) {
      for (let i = 0; i < containers.length; i++) {
        const fix = containerFix[0]; // Usually just one container fix pattern
        if (fix.securityContext) {
          containers[i].securityContext = deepMerge(
            containers[i].securityContext || {},
            fix.securityContext
          );
        }
        if (fix.resources) {
          containers[i].resources = deepMerge(
            containers[i].resources || {},
            fix.resources
          );
        }
        if (fix.livenessProbe) {
          containers[i].livenessProbe = deepMerge(
            containers[i].livenessProbe || {},
            fix.livenessProbe
          );
        }
        if (fix.readinessProbe) {
          containers[i].readinessProbe = deepMerge(
            containers[i].readinessProbe || {},
            fix.readinessProbe
          );
        }
      }
    }
  }

  // Handle spec.template.spec for Deployments, DaemonSets, etc.
  if (doc.spec?.template?.spec && fixSnippet.spec?.template?.spec) {
    doc.spec.template.spec = deepMerge(
      doc.spec.template.spec,
      fixSnippet.spec.template.spec
    );
  }

  // Handle automountServiceAccountToken
  if ('automountServiceAccountToken' in fixSnippet) {
    if (doc.spec?.template?.spec) {
      doc.spec.template.spec.automountServiceAccountToken = fixSnippet.automountServiceAccountToken;
    } else if (doc.spec) {
      doc.spec.automountServiceAccountToken = fixSnippet.automountServiceAccountToken;
    }
  }

  // Handle hostNetwork, hostPID, hostIPC
  for (const hostSetting of ['hostNetwork', 'hostPID', 'hostIPC']) {
    if (hostSetting in fixSnippet) {
      if (doc.spec?.template?.spec) {
        doc.spec.template.spec[hostSetting] = fixSnippet[hostSetting];
      } else if (doc.spec) {
        doc.spec[hostSetting] = fixSnippet[hostSetting];
      }
    }
  }
}

/**
 * Deep merge two objects
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key in source) {
    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Apply Terraform HCL fixes using regex patterns
 */
export function applyTerraformFixes(
  content: string,
  fixes: FixApplication[]
): ApplyResult {
  const appliedFixes: string[] = [];
  const failedFixes: string[] = [];
  let modifiedContent = content;

  for (const fix of fixes) {
    if (!fix.fix) {
      failedFixes.push(`${fix.checkId}: No fix snippet provided`);
      continue;
    }

    try {
      // Extract resource type and name from resourceName (e.g., "azurerm_storage_account.example")
      const resourceMatch = fix.resourceName?.match(/^([a-z_]+)\.(.+)$/);
      if (!resourceMatch) {
        failedFixes.push(`${fix.checkId}: Invalid resource name format`);
        continue;
      }

      const [, resourceType, resourceName] = resourceMatch;

      // Find the resource block
      const resourceRegex = new RegExp(
        `(resource\\s+"${resourceType}"\\s+"${resourceName.replace(/\[.*\]$/, '')}"\\s*\\{)`,
        'g'
      );

      if (!resourceRegex.test(modifiedContent)) {
        failedFixes.push(`${fix.checkId}: Resource block not found`);
        continue;
      }

      // Check if the fix attribute already exists
      const fixAttrMatch = fix.fix.match(/^\s*(\w+)\s*=/);
      if (fixAttrMatch) {
        const attrName = fixAttrMatch[1];
        const attrExistsRegex = new RegExp(
          `resource\\s+"${resourceType}"\\s+"${resourceName.replace(/\[.*\]$/, '')}"\\s*\\{[^}]*\\b${attrName}\\s*=`,
          's'
        );

        if (attrExistsRegex.test(modifiedContent)) {
          // Attribute exists - skip or update
          appliedFixes.push(`${fix.checkId} (already present)`);
          continue;
        }
      }

      // Insert the fix snippet after the opening brace
      const insertRegex = new RegExp(
        `(resource\\s+"${resourceType}"\\s+"${resourceName.replace(/\[.*\]$/, '')}"\\s*\\{)`,
        'g'
      );

      const fixIndented = fix.fix.split('\n').map(line => '  ' + line).join('\n');
      modifiedContent = modifiedContent.replace(
        insertRegex,
        `$1\n${fixIndented}`
      );

      appliedFixes.push(fix.checkId);
    } catch (err: any) {
      failedFixes.push(`${fix.checkId}: ${err.message}`);
    }
  }

  return {
    success: appliedFixes.length > 0,
    content: modifiedContent,
    appliedFixes,
    failedFixes
  };
}

/**
 * Check if an error indicates OpenAI quota exceeded
 */
export function isQuotaExceededError(error: any): boolean {
  if (!error) return false;

  return (
    error.code === 'QUOTA_EXCEEDED' ||
    error.isQuotaError === true ||
    error.code === 'insufficient_quota' ||
    error.status === 429 ||
    (error.message && (
      error.message.includes('quota') ||
      error.message.includes('rate limit') ||
      error.message.includes('exceeded') ||
      error.message.includes('billing')
    ))
  );
}
