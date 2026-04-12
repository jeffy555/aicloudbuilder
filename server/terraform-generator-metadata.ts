/**
 * Root-level JSON written on Terraform generation so future repo scans can detect
 * provenance and module approach without heuristics alone.
 */

export const TERRAFORM_GENERATOR_METADATA_FILENAME = ".aicloudbuilder.json";

export const TERRAFORM_GENERATOR_METADATA_SCHEMA_VERSION = 1;

export type TerraformModuleApproachForMetadata =
  | "child-module"
  | "standalone-root"
  | "aggregated-root"
  | string
  | null
  | undefined;

export interface TerraformGeneratorMetadata {
  schemaVersion: number;
  generator: "AICloudBuilder";
  moduleApproach: string | null;
  cloudProvider: string | null;
  generatedAt: string;
}

export function isTerraformGeneratorMetadataPath(path: string): boolean {
  const seg = path.replace(/^\/+|\/+$/g, "").split("/").pop() || "";
  return seg.toLowerCase() === TERRAFORM_GENERATOR_METADATA_FILENAME.toLowerCase();
}

export function buildTerraformGeneratorMetadata(session: {
  moduleApproach?: TerraformModuleApproachForMetadata;
  cloudProvider?: string | null;
}): string {
  const payload: TerraformGeneratorMetadata = {
    schemaVersion: TERRAFORM_GENERATOR_METADATA_SCHEMA_VERSION,
    generator: "AICloudBuilder",
    moduleApproach: session.moduleApproach ? String(session.moduleApproach) : null,
    cloudProvider: session.cloudProvider ? String(session.cloudProvider) : null,
    generatedAt: new Date().toISOString(),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Root-level Terraform resource files plus generator metadata, excluding backend-only files.
 * Matches filters used when fetching an existing repo for standalone append / session hydration.
 */
export function shouldIncludeFileInStandaloneRepoFetch(normalizedPath: string): boolean {
  const n = normalizedPath.replace(/^\/+|\/+$/g, "");
  const fileName = (n.split("/").pop() || n).toLowerCase();
  if (["backend.tf", "provider.tf", "terraform.tf"].includes(fileName)) return false;
  const isRootLevel = !n.includes("/") || n.split("/").length === 1;
  if (!isRootLevel) return false;
  if (fileName.endsWith(".tf") || fileName.endsWith(".tfvars")) return true;
  if (fileName === TERRAFORM_GENERATOR_METADATA_FILENAME.toLowerCase()) return true;
  return false;
}

export function parseTerraformGeneratorMetadata(
  content: string
): TerraformGeneratorMetadata | null {
  try {
    const raw = JSON.parse(content) as Partial<TerraformGeneratorMetadata>;
    if (raw?.generator !== "AICloudBuilder" || typeof raw.schemaVersion !== "number") {
      return null;
    }
    return {
      schemaVersion: raw.schemaVersion,
      generator: "AICloudBuilder",
      moduleApproach: typeof raw.moduleApproach === "string" ? raw.moduleApproach : null,
      cloudProvider: typeof raw.cloudProvider === "string" ? raw.cloudProvider : null,
      generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
    };
  } catch {
    return null;
  }
}
