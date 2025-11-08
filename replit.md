# AI-Driven DevOps Platform

## Overview
This AI-powered DevOps automation platform allows users to generate and commit Terraform configurations through natural language conversations. The platform aims to streamline DevOps workflows by offering AI-driven assistance in infrastructure as code (IaC) generation, with future expansions planned for Kubernetes and automation scripting. It guides users through a structured workflow to select providers, repositories, cloud platforms, and module approaches before generating and committing Terraform code. The platform integrates OpenAI's GPT-4o-mini and the Model Context Protocol (MCP) for seamless repository management.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
The frontend is built with React 18, TypeScript, and Vite, using Wouter for routing. State management is handled by TanStack Query for server state and React hooks for local component state, with session persistence via a backend API. UI components leverage Radix UI primitives and shadcn/ui (New York style) with custom theming and Tailwind CSS. The design system adopts a hybrid approach, combining modern developer aesthetics with GitHub's DevOps patterns, focusing on a conversational AI interface and a six-step wizard flow with responsive design.

### Backend Architecture
The backend uses Node.js with Express.js and TypeScript. It exposes RESTful APIs for session management, message handling, file generation, repository operations, and commit operations. Data persistence is currently in-memory but designed for PostgreSQL via Drizzle ORM. AI integration relies on OpenAI GPT-4o-mini for conversational AI and context-aware Terraform generation, supporting different module approaches. Repository integration is managed through the Model Context Protocol (MCP) client manager, abstracting operations for GitHub and Azure DevOps using spawned child processes.

### Data Storage Solutions
The current implementation uses in-memory Map-based data structures for users, sessions, messages, and generated files. The planned implementation will utilize PostgreSQL with Drizzle ORM, with a defined schema supporting user authentication, session tracking, message history, and versioned generated files (main.tf, variables.tf, terraform.tfvars, and README.md).

### UI/UX Decisions
The platform features a modern, clean UI inspired by Linear and GitHub. Key UI patterns include a step-based workflow, a conversational chat interface, a multi-file tabbed code editor, and clear action buttons for commit operations. The design emphasizes an AI-first approach with code-centric components and a responsive layout.

### Feature Specifications
The platform supports a six-step workflow:
1.  **Landing Page**: Selection of automation type.
2.  **Provider Selection**: Choice between GitHub and Azure DevOps.
3.  **Repository Selection**: Option to choose or create a repository.
4.  **Cloud Provider Selection**: Selection among Azure, AWS, or GCP.
5.  **Module Approach Selection**: Choose from Child Module, Standalone Root Module, or Aggregated Root Module for Terraform generation.
6.  **Terraform Generation**: Natural language description for infrastructure.
7.  **Review & Commit**: Review, edit, and commit generated Terraform files.

Key features include context-aware Terraform generation (main.tf, variables.tf, terraform.tfvars, README.md), a structured file browser, code preview, and integrated Checkov security scanning with commit gating.

## External Dependencies

### Repository Providers
-   **GitHub**: Utilizes Octokit REST API client and MCP GitHub server for listing, creating repositories, and committing files. Authenticated via `GITHUB_TOKEN`.
-   **Azure DevOps**: Uses a custom MCP Azure DevOps server. Authenticated via `AZURE_DEVOPS_PAT` with `AZURE_DEVOPS_ORG`. Supports listing repositories but has limitations in creating repositories or committing files directly.

### AI Services
-   **OpenAI API**: Employs the GPT-4o-mini model for chat completions and structured Terraform code generation.

### Database
-   **Neon Serverless PostgreSQL**: Configured for future data persistence, using `DATABASE_URL` and Drizzle ORM.

### Build & Development Tools
-   **Vite**: Frontend bundling and Hot Module Replacement.
-   **esbuild**: Server-side bundling.
-   **Replit development plugins**: For integrated development environment support.

### Environment Variables
-   `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `AZURE_DEVOPS_ORG`, `AZURE_DEVOPS_PAT`, `DATABASE_URL` (optional), `NODE_ENV`.
## Recent Changes

### Repository Scanning & Auto-Detection (Latest - Nov 8, 2025)
Implemented automatic repository scanning to detect existing Terraform configurations and adapt the workflow accordingly:

**Repository Scanning**:
- After selecting a repository, automatically scans for existing Terraform files
- Detects cloud provider from provider blocks (azurerm → Azure, aws → AWS, google → GCP)
- Determines module type:
  - Child module: Contains only `resource` blocks
  - Root module: Contains `module` blocks
  - Empty: No Terraform files found
- Stores detected configuration in session for AI context

**Adaptive Workflow**:
- **Existing Repositories**: Skips cloud provider and module approach steps, jumps directly to Step 5 (Generate)
- **New Repositories**: Follows standard workflow (Cloud → Module → Generate)
- AI prompts adapt based on detected configuration:
  - Child modules: Offers to create additional child modules
  - Root modules: Offers to add resources to existing configuration
  - New repos: Standard Terraform generation prompts

**Technical Implementation**:
- `server/terraform-parser.ts`: Analyzes Terraform files to detect providers and module types
- `server/mcp-client.ts`: Scans GitHub repositories using Octokit REST API
- `server/routes.ts`: New `/api/sessions/:id/scan-repository` endpoint
- `shared/schema.ts`: Added session fields for detected configuration tracking
- `server/openai-service.ts`: Adaptive AI prompts based on repository state
- `client/src/pages/TerraformWorkflow.tsx`: Trigger scan after repo selection, skip steps for existing repos

**Known Limitations**:
- GitHub: Full scanning support via Octokit REST API
- Azure DevOps: Repository scanning not available due to MCP limitations (no file content reading tools)
  - Azure DevOps users will follow standard workflow with manual configuration

### Improved File UI & Checkov Security Scanning (Nov 8, 2025)
Enhanced the review workflow (Step 6) with better file visibility and integrated security scanning:

**File Browser Improvements**:
- Replaced tab-based file navigation with structured list view
- Files organized by folder with visual grouping (e.g., "ResourceGroup/", "StorageAccount/")
- Radio button selection for intuitive file switching
- Two-panel layout: file list on left, code preview on right
- ScrollArea for handling large numbers of files
- Clear visual hierarchy with folder icons and file names

**Checkov Security Scanning**:
- Integrated Checkov static analysis tool for Terraform security validation
- Backend API endpoint (`POST /api/sessions/:id/scan`) runs Checkov in temporary directory
- Real-time scan results display with:
  - Pass percentage with visual progress bar
  - Detailed breakdown (passed/failed/skipped counts)
  - Failed checks with check ID, name, resource, file, and remediation guidelines
  - Sample passed checks for verification
- **Commit Gating**: Users must run security scan before commit button is enabled
- **Smart State Management**: Scan state automatically resets when files are generated or edited
- Users can commit despite failed checks (informed decision-making)
- Re-scan capability available after initial scan

**Technical Implementation**:
- `client/src/components/CodeEditor.tsx`: Redesigned with radio buttons and folder grouping
- `client/src/components/CheckovScanner.tsx`: New component for scan UI and results
- `server/routes.ts`: New `/scan` endpoint with Checkov CLI integration
- `client/src/pages/TerraformWorkflow.tsx`: Integrated scanner with scan state management
- Proper error handling for scan failures and empty file scenarios
- TypeScript type safety for scan results and component props

### Child Module Folder Organization & Validation (Nov 8, 2025)
Fixed critical bug where child modules incorrectly generated `module` blocks instead of `resource` blocks. Implemented folder-based organization and comprehensive validation:

**Critical Bug Fixes**:
1. **Resource vs Module Blocks** - Child modules now correctly generate `resource` blocks only
   - `module` blocks are forbidden in child modules (only allowed in aggregated root)
   - OpenAI prompts explicitly forbid module blocks with examples
   - Server-side validation rejects any child module containing module blocks

2. **Folder-Based Organization** - Child modules organized by resource type:
   - Example structure: `ResourceGroup/`, `StorageAccount/`, `FunctionApp/`, `LogicApp/`
   - Each folder contains: `main.tf` (resources), `variables.tf` (inputs), `outputs.tf` (exports)
   - Standalone/aggregated root modules maintain flat structure (backward compatible)

3. **Comprehensive Validation**:
   - Forbidden block detection: Rejects `module`, `provider`, `terraform` blocks in child modules
   - Structural validation: Ensures folder organization and required files per folder
   - Clear error messages guide users if validation fails
   - Validation runs before saving to prevent invalid configurations

**AI Response Improvements**:
- Removed "Breakdown of what to create" bundled sections from chat
- Step-by-step guidance instead of structured lists
- More conversational and focused responses

### Module Approach Selection (Nov 8, 2025)
Added a new Step 4 in the workflow to select the module approach before generating Terraform code.

**Three Module Approaches**:
1. **Child Module** - Generates reusable module code that:
   - Uses `resource` blocks to define infrastructure directly
   - Organized in folders by resource type (ResourceGroup/, StorageAccount/, etc.)
   - Each folder has main.tf, variables.tf, outputs.tf
   - NO provider configuration (follows module best practices)

2. **Standalone Root Module** - Generates a complete configuration that:
   - Uses `resource` blocks to define all infrastructure
   - Flat file structure (main.tf, variables.tf, terraform.tfvars)
   - Includes provider configuration
   - Ready to be applied directly

3. **Aggregated Root Module** - Generates a root module that:
   - Uses `module` blocks to call child modules
   - Flat file structure
   - Includes provider configuration
   - Aggregates outputs from child modules

## API Endpoints

### Session Management
- `POST /api/sessions` - Create a new session
- `GET /api/sessions/:id` - Get session details
- `PATCH /api/sessions/:id` - Update session state
- `GET /api/sessions/:id/messages` - Get conversation messages
- `POST /api/sessions/:id/messages/system` - Create system message
- `POST /api/sessions/:id/chat` - Send chat message

### Repository Operations
- `GET /api/repositories/:provider` - List repositories
- `POST /api/repositories/:provider` - Create repository (GitHub only)
- `POST /api/sessions/:id/scan-repository` - Scan repository for existing Terraform configuration

### Terraform Generation
- `POST /api/sessions/:id/generate-terraform` - Generate Terraform files
- `GET /api/sessions/:id/files` - Get generated files
- `PATCH /api/files/:id` - Update file content

### Security & Commit
- `POST /api/sessions/:id/scan` - Run Checkov security scan
- `POST /api/sessions/:id/commit` - Commit files to repository

## Known Limitations

### Azure DevOps MCP
- Cannot create repositories (must be created manually in Azure DevOps)
- Cannot commit files directly (no `push_files` or equivalent tool)
- Limited to repository listing and branch/PR management

### Recommendation
Use GitHub provider for full end-to-end functionality. Azure DevOps integration is limited to repository listing and Terraform generation only.
