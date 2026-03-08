/**
 * All Terraform / HCL regex patterns in one place.
 *
 * Rules:
 *   1. Every pattern is a module-level const — compiled once at startup.
 *   2. Stateful (global-flag) patterns must have their lastIndex reset before
 *      each exec loop: `PATTERN.lastIndex = 0;`
 *   3. Each pattern documents what HCL syntax it covers and any known limits.
 */

// ---------------------------------------------------------------------------
// File identification
// ---------------------------------------------------------------------------

/** File extensions that make up a Terraform project. */
export const TERRAFORM_FILE_EXTENSIONS = {
  HCL:    '.tf',
  TFVARS: '.tfvars',
  JSON:   '.tf.json',
} as const;

// ---------------------------------------------------------------------------
// HCL block parsers
// ---------------------------------------------------------------------------

/**
 * Matches a resource block opening line.
 * Captures: [1] resource type, [2] resource name.
 * Example: resource "azurerm_storage_account" "sa_main" {
 */
export const RESOURCE_BLOCK_PATTERN = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;

/**
 * Matches a variable declaration.
 * Captures: [1] variable name.
 * Example: variable "location" {
 */
export const VARIABLE_DECLARATION_PATTERN = /variable\s+"([^"]+)"/g;

/**
 * Matches a module block opening line.
 * Captures: [1] module name.
 * Example: module "network" {
 */
export const MODULE_BLOCK_PATTERN = /module\s+"([^"]+)"\s*\{/g;

/**
 * Matches source attribute inside a module block.
 * Captures: [1] source path or registry address.
 * Example: source = "./modules/network"
 */
export const MODULE_SOURCE_PATTERN = /source\s*=\s*"([^"]+)"/;

// ---------------------------------------------------------------------------
// tfvars parsers
// ---------------------------------------------------------------------------

/**
 * Matches a quoted string assignment.
 * Allows inline comments after the closing quote.
 * Example: location = "East US"  # primary region
 * Captures: [1] key, [2] value (without quotes).
 * Note: no trailing $ anchor — prevents inline comments from breaking the match.
 */
export const TFVARS_QUOTED_PATTERN = /^(\w+)\s*=\s*"([^"]*)"/;

/**
 * Matches an unquoted scalar assignment (numbers, booleans, identifiers).
 * Stops at whitespace, '#', or '"' to avoid consuming comment text or
 * accidentally matching the start of a quoted string.
 * Example: count = 3  # instances
 * Captures: [1] key, [2] value.
 */
export const TFVARS_UNQUOTED_PATTERN = /^(\w+)\s*=\s*([^\s#"]+)/;

/**
 * Matches a list assignment.  Global flag — reset lastIndex before each use.
 * Example: zones = ["East US", "West US 2"]
 * Captures: [1] key, [2] raw list content.
 */
export const TFVARS_LIST_PATTERN = /(\w+)\s*=\s*\[([^\]]+)\]/g;

/**
 * Matches a map/object assignment.  Global flag — reset lastIndex before each use.
 * Example: tags = { env = "prod", team = "platform" }
 * Captures: [1] key, [2] raw map content.
 */
export const TFVARS_MAP_PATTERN = /(\w+)\s*=\s*\{([^}]+)\}/g;

// ---------------------------------------------------------------------------
// Variable reference detection
// ---------------------------------------------------------------------------

/**
 * Detects usages of var.<name> inside attribute values.
 * Global flag — reset lastIndex before each use.
 * Example: location = var.azure_region
 * Captures: [1] variable name.
 */
export const VAR_USAGE_PATTERN = /var\.([a-zA-Z0-9_-]+)/g;

/**
 * Detects local.* references.
 * Global flag — reset lastIndex before each use.
 */
export const LOCAL_REF_PATTERN = /local\.([a-zA-Z0-9_-]+)/g;

// ---------------------------------------------------------------------------
// Module source classification
// ---------------------------------------------------------------------------

/**
 * A local relative path — source starts with ./ or ../
 */
export const LOCAL_MODULE_PATH = /^\.\.?\//;

/**
 * A git-hosted source (git::, github.com, bitbucket.org …).
 */
export const GIT_MODULE_SOURCE = /^git::|github\.com|bitbucket\.org|gitlab\.com/;

/**
 * A Terraform Registry address: namespace/module/provider
 * Optional sub-directory suffix: //submodule
 * Captures: [1] namespace, [2] module, [3] provider.
 */
export const REGISTRY_MODULE_PATTERN = /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)/;

// ---------------------------------------------------------------------------
// Resource type detection (for diagrams / source-file inference)
// ---------------------------------------------------------------------------

/**
 * Matches an azurerm_* resource type inside a .tf file.
 * Used when scanning module source files to infer the dominant resource.
 * Captures: [1] full resource type string.
 */
export const AZURE_RESOURCE_TYPE_PATTERN = /resource\s+"(azurerm_[^"]+)"\s+"[^"]+"/g;

/**
 * Matches direct resource references in attribute values.
 * Example: app_service_plan_id = azurerm_service_plan.asp.id
 * Captures: [1] resource type, [2] resource name.
 */
export const DIRECT_RESOURCE_REF_PATTERN = /(azurerm_\w+)\.(\w+)/;

// ---------------------------------------------------------------------------
// Mermaid / diagram output
// ---------------------------------------------------------------------------

/** Code-fence markers used when stripping Mermaid from AI-generated text. */
export const MERMAID_FENCE_OPEN  = '```mermaid';
export const GENERIC_FENCE_CLOSE = '```';

/**
 * Valid opening tokens for each supported Mermaid diagram type.
 * Used to validate that generated content is well-formed before returning it.
 */
export const MERMAID_VALID_TOKENS: Record<string, string[]> = {
  flowchart: ['graph', 'flowchart'],
  sequence:  ['sequenceDiagram'],
  mindmap:   ['mindmap'],
  class:     ['classDiagram'],
  er:        ['erDiagram'],
  state:     ['stateDiagram'],
  journey:   ['journey'],
  gantt:     ['gantt'],
  gitGraph:  ['gitGraph'],
};

// ---------------------------------------------------------------------------
// Refactor: hardcoded-value detection
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate a value is NOT a hardcoded literal (it's a reference
 * or a Terraform built-in keyword) and should be skipped during refactor analysis.
 */
export const TERRAFORM_REFERENCE_PREFIXES =
  /^(data\.|resource\.|module\.|local\.|path\.|self\.|count\.|each\.)/;

/** Pure numeric literal — not considered a configurable value. */
export const PURE_NUMBER_PATTERN = /^[0-9]+$/;

/** Boolean / null keywords in HCL. */
export const TERRAFORM_KEYWORD_PATTERN = /^(true|false|null)$/i;

/**
 * Patterns that identify well-known Azure / provider tier literals that are
 * acceptable as inline values (not worth extracting to a variable).
 */
export const PROVIDER_TIER_LITERAL_PATTERN = /^(azurerm_|aws_|google_|Standard|Premium|Basic)/i;
