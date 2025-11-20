# 📱 AI Cloud Builder - Complete User Flow

## 🎯 Application Overview

**AI-Driven DevOps Platform** that helps users generate Terraform infrastructure code using natural language, with AI assistance throughout the workflow.

---

## 🚀 Complete User Journey

### **Entry Point: Landing Page** (`/`)

**What the user sees:**
- Welcome page with three feature cards:
  1. **Terraform** (Available) - Generate infrastructure as code
  2. **Kubernetes** (Coming Soon)
  3. **Automation Scripts** (Coming Soon)

**User Action:**
- Clicks on "Terraform" card → Navigates to `/terraform`

**Backend:**
- No API call yet

---

### **Step 1: Provider Selection** (`/terraform` - Step 1)

**What the user sees:**
- Welcome message: "Welcome! Let's start by selecting your repository provider."
- Two provider cards:
  - **GitHub** (with CodeIcon)
  - **Azure DevOps** (with Cloud icon)
- Step indicator showing "Step 1 of 7: Provider"

**Backend Actions:**
1. `POST /api/sessions` → Creates new session in memory
2. `POST /api/sessions/:id/messages/system` → Creates welcome message
3. Session state: `currentStep: '1'`, `workflowStep: 'landing'`

**User Action:**
- Clicks on either GitHub or Azure DevOps card

**What happens:**
1. Frontend calls `handleProviderSelect('github' | 'azure')`
2. `PATCH /api/sessions/:id` → Updates session with `provider` and `currentStep: '2'`
3. `POST /api/sessions/:id/messages/system` → Adds confirmation message
4. Frontend moves to Step 2

**MCP Server:**
- Not started yet

---

### **Step 2: Repository Selection** (`/terraform` - Step 2)

**What the user sees:**
- System message: "Great! Now select an existing repository or create a new one."
- Two-column layout:
  - **Left**: List of repositories from selected provider
  - **Right**: Create new repository form (GitHub only) OR info message (Azure DevOps)

**Backend Actions:**
1. `GET /api/repositories/:provider` → Lists repositories
   - **GitHub**: Calls MCP server `@modelcontextprotocol/server-github`
     - MCP tool: `search_repositories` with query `user:{GITHUB_OWNER}`
   - **Azure DevOps**: Calls MCP server `@azure-devops/mcp`
     - MCP tool: `repo_list_repos_by_project`
   - **First MCP server starts here automatically!**

**User has two options:**

#### **Option A: Select Existing Repository**
- User clicks on a repository from the list

**What happens:**
1. `handleRepoSelect(repoId)` is called
2. `PATCH /api/sessions/:id` → Updates session with `repositoryId` and `repositoryName`
3. `POST /api/sessions/:id/scan-repository` → **Scans repository for existing Terraform files**
   - **GitHub**: Uses GitHub API to read `.tf` files
   - **Azure DevOps**: Returns empty (MCP limitation)
4. `POST /api/sessions/:id/scan-repository` → Analyzes Terraform files:
   - Detects cloud provider (Azure/AWS/GCP)
   - Detects module type (child/root/empty)
   - Detects existing backend configuration
   - Updates session with all detected info

**Two paths based on scan result:**

**Path 1: Existing Repo with Terraform Files**
- System message: "Found existing {moduleType} for {cloudProvider} with {N} Terraform files."
- **Skips to Step 5** (Backend Configuration) - AI guides user from here
- AI message: "I see this is a {child/root} module. Would you like to create additional modules or modify existing ones?"

**Path 2: New/Empty Repo**
- System message: "This appears to be a new repository. Let's configure it from scratch."
- **Moves to Step 3** (Cloud Provider Selection)

#### **Option B: Create New Repository** (GitHub only)
- User fills form with repository name and description
- Clicks "Create Repository"

**What happens:**
1. `POST /api/repositories/github` → Creates repository via MCP
   - MCP tool: `create_repository` (without auto_init)
2. `PATCH /api/sessions/:id` → Updates session with `repositoryName` and `currentStep: '3'`
3. **Moves to Step 3** (Cloud Provider Selection)

**Azure DevOps Note:**
- Cannot create repos via MCP
- Shows info message: "Please create repository manually in Azure DevOps"

---

### **Step 3: Cloud Provider Selection** (`/terraform` - Step 3)

**What the user sees:**
- Three cloud provider cards:
  - **Microsoft Azure** (Cloud icon)
  - **Amazon Web Services** (CloudCog icon)
  - **Google Cloud Platform** (Package icon)
- System message: "Perfect! Now choose your target cloud provider (Azure, AWS, or GCP)."

**Backend Actions:**
- No API call yet (just UI selection)

**User Action:**
- Clicks on a cloud provider card

**What happens:**
1. `handleCloudProviderSelect('azure' | 'aws' | 'gcp')`
2. `PATCH /api/sessions/:id` → Updates session with `cloudProvider` and `currentStep: '4'`
3. System message: "Selected {Cloud Name}"
4. **Moves to Step 4** (Module Approach)

---

### **Step 4: Module Approach Selection** (`/terraform` - Step 4)

**What the user sees:**
- Three module approach cards:
  - **Child Module** - Reusable components
  - **Standalone Root Module** - Complete infrastructure
  - **Aggregated Root Module** - Composed from child modules
- System message: "Great! Now choose your module approach..."

**User Action:**
- Clicks on a module approach card

**What happens:**
1. `handleModuleApproachSelect('child-module' | 'standalone-root' | 'aggregated-root')`
2. `PATCH /api/sessions/:id` → Updates session with `moduleApproach` and `currentStep: '5'`

**Two paths based on selection:**

#### **Path 1: Child Module Selected**
- System message: "Child modules don't require backend configuration."
- **Skips Step 5** → **Moves directly to Step 6** (Generate)
- `backendConfigured: true` (marked as skipped)

#### **Path 2: Root Module Selected** (Standalone or Aggregated)
- **Moves to Step 5** (Backend Configuration)
- **Auto-detection logic:**
  - If existing `backend.tf` found → Auto-validates backend
  - If no backend + Azure → Auto-creates backend with defaults
  - Otherwise → Shows manual options

---

### **Step 5: Backend Configuration** (`/terraform` - Step 5)

**Only shown for Root Modules**

**What the user sees:**
- Card explaining Terraform backend configuration
- Three action buttons:
  1. **Create with Defaults** - Auto-generate backend
  2. **Skip Backend** - Use local state
  3. **Validate Existing** - Validate existing backend.tf (Azure only)

**Backend Actions:**

#### **Option 1: Create with Defaults**
1. `POST /api/sessions/:id/configure-backend` with `action: 'create'`
2. **Azure Resources MCP server starts automatically!**
   - Validates/creates Resource Group
   - Validates/creates Storage Account
   - Validates/creates Blob Container
   - Uses MCP tools: `azure_create_resource_group`, `azure_create_storage_account`, `azure_create_blob_container`
3. Updates session with backend configuration
4. System message: "Backend resources created successfully in Azure."
5. **Moves to Step 6**

#### **Option 2: Validate Existing**
1. `POST /api/sessions/:id/configure-backend` with `action: 'validate'`
2. **Azure Resources MCP server starts automatically!**
   - Validates storage account exists
   - Validates container exists
   - Uses MCP tools: `azure_list_storage_accounts`, `azure_list_blob_containers`
3. Updates session with validation status
4. **Moves to Step 6**

#### **Option 3: Skip Backend**
1. `POST /api/sessions/:id/configure-backend` with `action: 'decline'`
2. Updates session: `backendDeclined: 'true'`, `backendValidated: 'skipped'`
3. System message: "Backend configuration skipped. Terraform will use local state management."
4. **Moves to Step 6**

---

### **Step 6: Generate Terraform** (`/terraform` - Step 6)

**What the user sees:**
- Chat interface at the bottom
- Placeholder: "Describe your Terraform setup... e.g., 'Create Terraform for Azure Storage Account and Resource Group'"
- System message: "Perfect! Now describe the infrastructure you want to create. Be specific about resources, configurations, and requirements."
- Chat history showing all previous messages

**User Action:**
- Types natural language description in chat input
- Example: "Create a storage account and resource group in Azure"

**What happens:**
1. `POST /api/sessions/:id/chat` → Saves user message, gets AI response
   - AI provides context-aware guidance based on:
     - Current step
     - Detected repository state
     - Module approach
     - Cloud provider
2. `POST /api/sessions/:id/generate-terraform` → **Generates Terraform files**
   - Calls OpenAI GPT-4o-mini with specialized prompt
   - **Child Module**: Generates folder-based structure (ResourceType/main.tf, variables.tf, outputs.tf)
   - **Root Module**: Generates flat structure (main.tf, variables.tf, terraform.tfvars, outputs.tf, backend.tf, provider.tf)
   - Validates child modules (no module blocks, no provider config)
   - Creates README.md with usage instructions
   - Saves all files to session storage
3. Updates session: `currentStep: '6'` → **Moves to Step 7**

**AI Generation Details:**
- Uses `gpt-4o-mini` model
- Temperature: 0.3 (for consistent code generation)
- Response format: JSON with files array
- Each file has `path` and `content`
- Includes backend.tf and provider.tf for root modules

---

### **Step 7: Review & Commit** (`/terraform` - Step 7)

**What the user sees:**
- **Code Editor** showing all generated files
  - File tree on left
  - Code editor on right
  - User can edit files
- **Checkov Security Scanner** component
  - "Run Security Scan" button
  - Shows scan results (passed/failed checks)
- **Action Buttons**:
  - **Approve & Commit** (disabled until scan completed)
  - **Cancel** (goes back to Step 6)

**Backend Actions:**
1. `GET /api/sessions/:id/files` → Fetches all generated files
2. User can edit files → `PATCH /api/files/:id` → Updates file content

**User Workflow:**

#### **Step 7a: Review Files**
- User reviews generated Terraform code
- Can edit files in the code editor
- Changes are saved automatically

#### **Step 7b: Run Security Scan**
- User clicks "Run Security Scan" button
- `POST /api/sessions/:id/scan` → Runs Checkov
  - Creates temporary directory
  - Writes all Terraform files
  - Runs: `checkov -d {tempDir} --framework terraform --output json`
  - Parses results (passed/failed/skipped checks)
  - Returns summary and detailed check results
- Shows scan results:
  - Summary: X passed, Y failed, Z skipped
  - Failed checks with details (check ID, resource, guideline)
  - Pass percentage
- `scanCompleted: true` → Enables "Approve & Commit" button

#### **Step 7c: Commit Files**
- User clicks "Approve & Commit" button
- `POST /api/sessions/:id/commit` → Commits files to repository
  1. Gets all files from session
  2. `POST /api/sessions/:id/generate-commit-message` → AI generates commit message
     - Uses OpenAI to analyze files and create descriptive message
  3. **GitHub**: Commits via MCP or GitHub REST API
     - MCP tool: `push_files` (for non-empty repos)
     - Falls back to GitHub Contents API for empty repos
  4. **Azure DevOps**: Shows error (MCP limitation - cannot commit directly)
  5. Updates session state
  6. Shows success toast: "Your Terraform configuration has been committed: {commitMessage}"
  7. `isCommitted: true` → Disables commit button

**Success State:**
- Files are committed to repository
- User sees success message
- Chat shows: "Files committed successfully with message: '{commitMessage}'"

---

## 🔄 State Management

### **Session State** (Stored in Memory)
```typescript
{
  id: string,
  provider: 'github' | 'azure' | null,
  repositoryId: string | null,
  repositoryName: string | null,
  cloudProvider: 'azure' | 'aws' | 'gcp' | null,
  moduleApproach: 'child-module' | 'standalone-root' | 'aggregated-root' | null,
  currentStep: '1' | '2' | '3' | '4' | '5' | '6' | '7',
  workflowStep: 'landing' | 'provider_selection' | ... | 'terraform_generation',
  isExistingRepo: 'true' | 'false' | null,
  detectedCloudProvider: string | null,
  detectedModuleType: 'child' | 'root' | 'empty' | null,
  detectedTerraformFiles: string[] | null,
  hasBackend: 'true' | 'false' | null,
  backendType: 'azurerm' | 'aws' | 'gcs' | null,
  backendStorageAccount: string | null,
  backendResourceGroup: string | null,
  backendContainer: string | null,
  backendStateKey: string | null,
  backendLocation: string | null,
  backendValidated: 'true' | 'false' | 'pending' | 'skipped' | null,
  backendDeclined: 'true' | 'false' | null
}
```

### **Frontend State**
- `sessionId` - Current session ID
- `currentStep` - UI step (1-7)
- `provider` - Selected provider
- `selectedRepo` - Selected repository ID
- `cloudProvider` - Selected cloud
- `moduleApproach` - Selected approach
- `isCommitted` - Commit status
- `scanCompleted` - Security scan status
- `repositoryScanResult` - Repository analysis results
- `backendConfigured` - Backend configuration status

---

## 🤖 AI Integration Points

### **1. Context-Aware Chat** (`/api/sessions/:id/chat`)
- **When**: Step 1-6 (any step with chat)
- **Purpose**: Provides guidance based on workflow step and repository state
- **Model**: `gpt-4o-mini`
- **Temperature**: 0.7
- **Max Tokens**: 500
- **Context Includes**:
  - Current workflow step
  - Detected repository configuration
  - Module type and cloud provider
  - Existing Terraform files

### **2. Terraform Generation** (`/api/sessions/:id/generate-terraform`)
- **When**: Step 6 (Generate)
- **Purpose**: Generates Terraform code from natural language
- **Model**: `gpt-4o-mini`
- **Temperature**: 0.3 (for consistent code)
- **Max Tokens**: 4000
- **Response Format**: JSON with files array
- **Specialized Prompts**:
  - Child Module: Folder-based structure, resource blocks only
  - Standalone Root: Flat structure with opinionated defaults
  - Aggregated Root: Module blocks calling child modules

### **3. Commit Message Generation** (`/api/sessions/:id/commit`)
- **When**: Step 7 (Review & Commit)
- **Purpose**: Generates descriptive commit message
- **Model**: `gpt-4o-mini`
- **Temperature**: 0.5
- **Max Tokens**: 100
- **Input**: List of file names and contents

---

## 🔌 MCP Server Integration

### **GitHub MCP Server** (`@modelcontextprotocol/server-github`)
- **Starts**: When listing/creating/committing to GitHub repos
- **Tools Used**:
  - `search_repositories` - List repos
  - `create_repository` - Create new repo
  - `push_files` - Commit files (non-empty repos)
- **Environment**: `GITHUB_PERSONAL_ACCESS_TOKEN`

### **Azure DevOps MCP Server** (`@azure-devops/mcp`)
- **Starts**: When listing Azure DevOps repos
- **Tools Used**:
  - `repo_list_repos_by_project` - List repos
- **Limitations**: Cannot create repos or read file contents
- **Environment**: `AZURE_DEVOPS_PAT`, `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PROJECT`

### **Azure Resources MCP Server** (`@azure/mcp@latest`)
- **Starts**: When managing Azure resources (backend configuration)
- **Tools Used**:
  - `azure_list_resource_groups` - List/validate resource groups
  - `azure_create_resource_group` - Create resource group
  - `azure_list_storage_accounts` - List/validate storage accounts
  - `azure_create_storage_account` - Create storage account
  - `azure_list_blob_containers` - List/validate containers
  - `azure_create_blob_container` - Create container
- **Authentication**: Azure CLI (`az login`)

---

## 📊 Data Flow Summary

```
User Action → Frontend Handler → API Call → Backend Route → Service Layer → MCP/AI → Response → UI Update
```

### **Example: Generate Terraform**
1. User types description → `handleGenerateRequest()`
2. `POST /api/sessions/:id/chat` → Saves message, gets AI response
3. `POST /api/sessions/:id/generate-terraform` → Calls `openaiService.generateTerraform()`
4. OpenAI API → Returns JSON with files
5. Files saved to storage → `storage.createFile()`
6. Session updated → `currentStep: '7'`
7. Frontend refetches files → Shows in code editor

---

## 🎯 Key Features

1. **Intelligent Repository Scanning**: Auto-detects existing Terraform configs
2. **Context-Aware AI**: Adapts responses based on workflow state
3. **Auto-Backend Configuration**: Creates Azure resources automatically
4. **Security Scanning**: Checkov integration for code validation
5. **Multi-Provider Support**: GitHub and Azure DevOps
6. **Module Validation**: Ensures correct Terraform structure
7. **Real-time Chat**: AI guidance throughout workflow
8. **Code Editing**: Edit generated files before committing

---

## 🔄 Alternative Flows

### **Flow A: Existing Repository with Terraform**
- Step 1 → Step 2 → **Scan detects existing files** → **Skip to Step 5** → Step 6 → Step 7

### **Flow B: Child Module (No Backend)**
- Step 1 → Step 2 → Step 3 → Step 4 → **Skip Step 5** → Step 6 → Step 7

### **Flow C: Azure DevOps (Limited Features)**
- Step 1 → Step 2 → **Cannot scan files** → Step 3 → Step 4 → Step 5 → Step 6 → Step 7
- **Cannot commit files** (MCP limitation)

---

## 📝 Notes

- **Storage**: All data is in-memory (lost on server restart)
- **Sessions**: One session per user workflow
- **Files**: Stored per session, deleted when new generation starts
- **MCP Servers**: Started lazily, cached, cleaned up on exit
- **AI**: Uses OpenAI GPT-4o-mini for all AI features
- **Security**: Checkov scans before commit (optional but recommended)

---

This flow ensures users can go from idea to committed Terraform code with AI assistance at every step! 🚀




