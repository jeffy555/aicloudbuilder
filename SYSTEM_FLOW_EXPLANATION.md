# System Flow Explanation: Validate & Fix, Terraform Generation, and Checkov Scan

**Date:** 2025-11-19  
**Purpose:** Explain how the system handles validation, Terraform generation, and security scanning

---

## 1. "Validate & Fix" Button - How It Works

### Location
- **UI Component:** `client/src/components/RefactorValidator.tsx`
- **Backend Endpoints:** 
  - `/api/sessions/:id/refactor` (validation)
  - `/api/sessions/:id/refactor-fix` (automatic fixing)

### What It Does

#### Step 1: Validation (`/api/sessions/:id/refactor`)
1. **Fetches Files:** Gets all Terraform files from session storage
2. **Checks for Issues:**
   - ✅ **Missing Variable Declarations:** Variables used in `main.tf` but not declared in `variables.tf`
   - ✅ **Missing Variable Values:** Variables declared but not assigned in `.tfvars`
   - ⚠️ **Hardcoded Values:** Hardcoded values in `main.tf` that should be variables
   - ⚠️ **Hardcoded Defaults:** Variables with defaults that are also in `.tfvars` (redundant)

3. **Current Implementation:**
   - Uses **regex-based pattern matching** to detect issues
   - Has a **hardcoded list** of configurable attributes: `['name', 'location', 'region', 'account_tier', ...]`
   - **NOT fully AI-driven** - relies on predefined patterns

#### Step 2: Automatic Fixing (`/api/sessions/:id/refactor-fix`)
1. **Runs Multiple Passes:** Up to 5 passes to fix interdependent issues
2. **Fixes Applied:**
   - Adds missing variable declarations to `variables.tf`
   - Adds missing variable values to `.tfvars`
   - Replaces hardcoded values with `var.` references
   - Removes redundant defaults from `variables.tf`

3. **Current Implementation:**
   - Uses **regex-based replacement** for fixes
   - **NOT AI-driven** - uses pattern matching and string replacement
   - May miss complex cases that require AI understanding

### Enhanced Implementation (AI-Driven)

**✅ Now Includes:**
1. **AI-Driven Best Practices Validation:**
   - Detects multiple resources of same type without `count`/`for_each` (ERROR)
   - Identifies hardcoded configurable values using AI understanding
   - Checks code structure and organization
   - Validates resource naming patterns
   - Uses AI to determine which attributes should be variables

2. **AI-Driven Fixing:**
   - Intelligently refactors multiple resources to use `count`/`for_each`
   - Applies fixes while preserving all functionality
   - Updates code structure intelligently
   - Handles complex scenarios that regex can't

3. **Hybrid Approach:**
   - AI handles complex best practices issues
   - Regex-based fixes for simple variable issues (faster)
   - Multiple passes ensure all issues are resolved

---

## 2. Terraform Generation for Multiple Resources

### Example: "Add 4 storage accounts"

### Current Flow

#### Step 1: Request Analysis
- **Location:** `server/openai-service.ts` → `generateTerraform()`
- **Process:**
  1. AI analyzes the request description
  2. Extracts resource types and requirements
  3. Refines the description for Terraform generation

#### Step 2: Terraform Documentation Fetching
- **Source:** Terraform MCP Server (`terraform-mcp-server` package)
- **Location:** `server/mcp-client.ts` → `fetchTerraformDocumentation()`
- **Process:**
  1. Connects to Terraform MCP server
  2. Fetches latest documentation for identified resources
  3. Falls back to OpenAI knowledge if MCP fails

#### Step 3: Code Generation
- **Source:** OpenAI (GPT-4o-mini) with MCP documentation
- **Location:** `server/openai-service.ts` → `generateTerraform()`
- **AI Prompt Includes:**
  ```
  CRITICAL: When adding multiple resources of the same type (e.g., "add 5 storage accounts"), 
  ALWAYS use for_each or count meta-arguments instead of creating multiple resource blocks.
  
  - Choose for_each when: You need stable resource identification, want to avoid state issues
  - Choose count when: You have a simple numeric requirement or need sequential numbering
  ```

### How It Should Work

**For "Add 4 storage accounts":**

**✅ Best Practice (Expected):**
```terraform
resource "azurerm_storage_account" "storage_accounts" {
  for_each = toset(["sa1", "sa2", "sa3", "sa4"])
  
  name                     = "${var.storage_account_prefix}-${each.key}"
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier            = var.account_tier
  account_replication_type = var.account_replication_type
}
```

**❌ Bad Practice (What might happen if AI doesn't follow guidance):**
```terraform
resource "azurerm_storage_account" "sa1" { ... }
resource "azurerm_storage_account" "sa2" { ... }
resource "azurerm_storage_account" "sa3" { ... }
resource "azurerm_storage_account" "sa4" { ... }
```

### Current Status

**✅ AI Prompt Has Guidance:**
- The prompt explicitly instructs AI to use `count` or `for_each`
- Guidance is present in both "new files" and "append to existing" scenarios

**⚠️ Potential Issues:**
- AI might not always follow the guidance
- No validation to ensure AI actually used `count`/`for_each`
- No post-generation check to verify best practices

---

## 3. Terraform MCP Server vs AI

### Terraform MCP Server Usage

**What It Does:**
- ✅ Fetches **latest Terraform documentation** for specific resources
- ✅ Provides **up-to-date resource schemas** and examples
- ✅ Used as **reference material** for AI generation

**Location:** `server/mcp-client.ts` → `fetchTerraformDocumentation()`

**Process:**
1. Connects to `terraform-mcp-server` package
2. Requests documentation for specific resources (e.g., `azurerm_storage_account`)
3. Returns documentation that is included in AI prompt
4. AI uses this documentation to generate accurate code

**Note:** MCP server provides **documentation**, not code generation

### AI Generation

**What It Does:**
- ✅ **Actually generates** the Terraform code
- ✅ Uses MCP documentation as reference
- ✅ Applies best practices from prompts
- ✅ Handles multiple resources, variables, etc.

**Location:** `server/openai-service.ts` → `generateTerraform()`

**Process:**
1. Receives user description
2. Gets Terraform documentation from MCP (if available)
3. Gets existing files (if appending)
4. Sends comprehensive prompt to OpenAI
5. OpenAI generates Terraform code following best practices

### Summary

- **Terraform MCP Server:** Provides documentation/reference
- **AI (OpenAI):** Generates the actual code
- **Best Practices:** Enforced through AI prompts, not MCP server

---

## 4. Checkov Security Scan - How It Works

### Location
- **Backend Endpoint:** `/api/sessions/:id/scan`
- **File:** `server/routes.ts` (line 2493)

### Process Flow

#### Step 1: File Collection
1. **Primary Source:** Session storage (latest generated code)
2. **Fallback:** Repository files if session storage is empty
3. **Filters:** Only `.tf`, `.tfvars`, `.hcl` files with content

#### Step 2: Temporary Directory Creation
1. Creates temp directory: `.temp-checkov/checkov-{random}/`
2. Writes all Terraform files to temp directory
3. Maintains file structure (handles nested paths)

#### Step 3: Checkov Execution
1. **Command:** Runs `checkov` CLI tool
2. **Format:** JSON output (`--framework terraform --output json`)
3. **Directory:** Scans the temporary directory
4. **Platform Detection:** Handles Windows vs Linux command variations

#### Step 4: Result Parsing
1. Parses Checkov JSON output
2. Categorizes checks:
   - **Passed:** Security checks that passed
   - **Failed:** Security checks that failed
   - **Skipped:** Checks that were skipped
3. Extracts:
   - Check ID (e.g., `CKV_AZURE_59`)
   - Check name
   - Resource affected
   - File location
   - Security guideline URL

#### Step 5: Cleanup
1. Deletes temporary directory
2. Returns results to client

### What Checkov Scans

**Security Checks:**
- Encryption settings
- Public access controls
- Authentication requirements
- TLS/HTTPS enforcement
- Network security
- Data protection
- Compliance requirements

**Example Checks:**
- `CKV_AZURE_59`: Ensure storage accounts disallow public access
- `CKV_AZURE_70`: Ensure Function apps are only accessible over HTTPS
- `CKV_AZURE_33`: Ensure Storage logging is enabled

### Current Implementation

**✅ Working:**
- Fetches files from session storage
- Creates temp directory
- Runs Checkov scan
- Parses and returns results

**⚠️ Potential Issues:**
- Checkov must be installed on the system
- Windows path handling can be tricky
- Large files might cause timeouts

---

## 5. Issues and Recommendations

### Issue 1: Validate & Fix Not Fully AI-Driven

**Problem:**
- Uses hardcoded attribute list
- Regex-based detection
- Simple string replacement

**Recommendation:**
- Make attribute detection AI-driven
- Use AI to understand context
- Use AI to apply fixes intelligently

### Issue 2: No Validation of AI Output

**Problem:**
- No check if AI used `count`/`for_each` for multiple resources
- No verification that best practices were followed

**Recommendation:**
- Add post-generation validation
- Check if multiple resources use `count`/`for_each`
- Re-generate if best practices not followed

### Issue 3: Checkov Scan Timing

**Problem:**
- Scan happens after generation
- No pre-generation validation

**Recommendation:**
- Consider running Checkov after generation
- Use results to improve next generation

---

## Summary

### Current Architecture

1. **Terraform Generation:**
   - ✅ Uses AI (OpenAI) with Terraform MCP documentation
   - ✅ Has best practices guidance in prompts
   - ⚠️ No validation that AI followed guidance

2. **Validate & Fix:**
   - ⚠️ Uses regex-based detection (not fully AI-driven)
   - ⚠️ Has hardcoded attribute list
   - ✅ Can fix basic issues automatically

3. **Checkov Scan:**
   - ✅ Works correctly
   - ✅ Scans session storage files
   - ✅ Returns detailed results

### Recommendations

1. **Make Validate & Fix AI-Driven:**
   - Use AI to detect configurable attributes
   - Use AI to apply fixes intelligently

2. **Add Post-Generation Validation:**
   - Verify `count`/`for_each` usage
   - Verify best practices compliance

3. **Enhance AI Prompts:**
   - Make best practices guidance more explicit
   - Add examples for multiple resources

---

**Document Created:** 2025-11-19

