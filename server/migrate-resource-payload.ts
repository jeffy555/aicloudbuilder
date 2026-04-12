/**
 * Builds Azure resource JSON for MigrateOps prompts: includes full `properties` from live API,
 * with adaptive truncation so prompts stay within model context limits.
 */

const DEFAULT_PER_RESOURCE_PROP_MAX = 14_000;
/** Target max size for the resources JSON blob (chars). Leave room for instructions + model output. */
const TARGET_PAYLOAD_MAX_CHARS = 280_000;

export type AzureLikeResource = {
  id?: string;
  name?: string;
  type?: string;
  location?: string;
  resourceGroup?: string;
  sku?: string;
  tier?: string;
  properties?: unknown;
  /** Pre-extracted Terraform-relevant slices from live ARM (see migrate-azure-enrichment.ts) */
  migrateopsTerraformHints?: unknown;
  /** ARM → azurerm 4.x attribute guidance (see migrate-schema-guidance.ts) */
  migrateopsSchemaGuidance?: unknown;
  /** Authoritative Terraform-ready values derived from ARM (see migrate-resolve.ts) */
  migrateopsResolvedTerraform?: unknown;
};

function serializeOne(r: AzureLikeResource, propMaxChars: number): Record<string, unknown> {
  const props = r.properties;
  let propertiesOut: unknown = props;
  if (props != null && typeof props === 'object') {
    const raw = JSON.stringify(props);
    if (raw.length > propMaxChars) {
      propertiesOut = {
        _migrateops_truncated: true,
        _original_length: raw.length,
        _partial_json: raw.slice(0, propMaxChars),
      };
    }
  } else if (props != null) {
    propertiesOut = props;
  }

  const row: Record<string, unknown> = {
    id: r.id ?? '',
    name: r.name ?? '',
    type: r.type ?? '',
    location: r.location ?? '',
    resourceGroup: r.resourceGroup ?? '',
    sku: r.sku ?? '',
    tier: r.tier ?? '',
    properties: propertiesOut,
  };
  if (r.migrateopsTerraformHints != null) {
    row.migrateopsTerraformHints = r.migrateopsTerraformHints;
  }
  if (r.migrateopsSchemaGuidance != null) {
    row.migrateopsSchemaGuidance = r.migrateopsSchemaGuidance;
  }
  if (r.migrateopsResolvedTerraform != null) {
    row.migrateopsResolvedTerraform = r.migrateopsResolvedTerraform;
  }
  return row;
}

/**
 * Returns pretty-printed JSON string of all resources, shrinking property detail until under cap.
 */
export function buildMigrateOpsAzureResourcePayloadString(
  resources: AzureLikeResource[],
  options?: { perResourcePropertyMaxChars?: number }
): { payload: string; perResourceCapUsed: number; truncatedGlobally: boolean } {
  let cap = options?.perResourcePropertyMaxChars ?? DEFAULT_PER_RESOURCE_PROP_MAX;
  let truncatedGlobally = false;

  for (let attempt = 0; attempt < 14; attempt++) {
    const prepared = resources.map((r) => serializeOne(r, cap));
    const payload = JSON.stringify(prepared, null, 2);
    if (payload.length <= TARGET_PAYLOAD_MAX_CHARS || cap <= 400) {
      if (payload.length > TARGET_PAYLOAD_MAX_CHARS) {
        truncatedGlobally = true;
        console.warn(
          `[MigrateOps] Resource payload ${payload.length} chars still exceeds soft cap ${TARGET_PAYLOAD_MAX_CHARS} (per-resource prop cap=${cap})`
        );
      }
      return { payload, perResourceCapUsed: cap, truncatedGlobally };
    }
    cap = Math.floor(cap * 0.65);
    truncatedGlobally = true;
  }

  const fallback = resources.map((r) => {
    const row: Record<string, unknown> = {
      id: r.id,
      name: r.name,
      type: r.type,
      location: r.location,
      resourceGroup: r.resourceGroup,
    };
    return row;
  });
  return {
    payload: JSON.stringify(fallback, null, 2),
    perResourceCapUsed: 0,
    truncatedGlobally: true,
  };
}
