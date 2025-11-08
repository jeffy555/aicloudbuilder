# AI-Driven DevOps Platform

## Overview

This is an AI-powered DevOps automation platform that enables users to generate and commit Terraform configurations through natural language conversations. The application features a landing page that showcases current and future DevOps automation capabilities (Terraform, Kubernetes, Automation Scripting).

The platform guides users through a six-step workflow:
1. **Landing Page** - Select automation type (currently Terraform, with Kubernetes and Automation Scripting coming soon)
2. **Provider Selection** - Choose repository provider (GitHub or Azure DevOps)
3. **Repository Selection** - Choose or create a repository
4. **Cloud Provider Selection** - Select target cloud (Azure, AWS, or GCP)
5. **Module Approach Selection** - Choose module approach (child module, standalone root, or aggregated root)
6. **Terraform Generation** - Describe infrastructure in natural language
7. **Review & Commit** - Review, edit, and commit generated Terraform files

The platform uses a conversational interface powered by OpenAI's GPT-4o-mini model, integrated with the Model Context Protocol (MCP) for repository management operations.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

**Framework**: React 18 with TypeScript, using Vite as the build tool

**Routing**: Wouter for lightweight client-side routing

**State Management**: 
- TanStack Query (React Query) v5 for server state management and caching
- React hooks for local component state
- Session-based state persistence via backend API

**UI Components**: 
- Radix UI primitives for accessible, headless components
- shadcn/ui component library (New York style variant) with custom theming
- Tailwind CSS for styling with custom design tokens
- Font stack: Inter for UI, JetBrains Mono for code

**Design System**:
- Hybrid approach combining Linear's modern developer aesthetic with GitHub's DevOps patterns
- Conversational AI-focused interface with code-centric components
- Four-step wizard flow with progress indicators
- Responsive layout with mobile-first considerations

**Key UI Patterns**:
- Step-based workflow (Provider → Repository → Cloud → Module → Generate → Review)
- Conversational chat interface with AI and user message components
- Code editor with multi-file tabs for Terraform configuration
- Repository selection with radio group pattern
- Module approach selection with three options
- Action confirmation buttons for commit operations

### Backend Architecture

**Runtime**: Node.js with Express.js server

**Language**: TypeScript with ES modules

**API Design**: RESTful endpoints under `/api` prefix
- Session management (`/api/sessions`)
- Message handling (`/api/sessions/:id/messages`)
- File generation (`/api/sessions/:id/files`)
- Repository operations (`/api/repositories`)
- Commit operations (`/api/commit`)

**Data Persistence**:
- In-memory storage implementation (MemStorage class) for development
- Designed to support PostgreSQL via Drizzle ORM (schema defined, not yet connected)
- Session-based architecture with message history and generated file storage

**AI Integration**:
- OpenAI GPT-4o-mini for conversational AI and Terraform generation
- Context-aware system prompts based on current workflow step
- Module approach-aware Terraform generation (child module, standalone root, aggregated root)
- AI chat only active during Step 5 (Generate) for relevant responses
- System messages for step transitions without triggering AI
- Structured generation of main.tf, variables.tf, terraform.tfvars, and README.md files
- README includes cloud provider and module approach metadata

**Repository Integration**:
- Model Context Protocol (MCP) client manager for abstracted repository operations
- Dual provider support: GitHub (@modelcontextprotocol/server-github) and Azure DevOps (@azure-devops/mcp)
- Spawned child processes for MCP server instances
- StdioClientTransport for communication with MCP servers

**Development Features**:
- Vite HMR (Hot Module Replacement) in development mode
- Request logging middleware for API calls
- Replit-specific plugins for development environment integration

### Data Storage Solutions

**Current Implementation**: In-memory storage with Map-based data structures
- Users map
- Sessions map
- Messages map
- Generated files map

**Planned Implementation**: PostgreSQL with Drizzle ORM
- Database schema defined in `shared/schema.ts`
- Tables: users, sessions, messages, generatedFiles
- UUID primary keys with auto-generation
- Foreign key relationships (sessions ↔ messages, sessions ↔ files)
- Timestamp tracking for created/updated records
- Neon serverless PostgreSQL adapter configured

**Schema Design**:
- User authentication support (username/password)
- Session tracking with provider, repository, cloud provider, and module approach metadata
- Step progression tracking (currentStep: 1-6)
- Cloud provider selection (azure/aws/gcp)
- Module approach selection (child-module/standalone-root/aggregated-root)
- Conversation history via messages table
- Generated file versioning with update timestamps
- Supports 4 generated files: main.tf, variables.tf, terraform.tfvars, README.md

### External Dependencies

**Repository Providers**:
- **GitHub**: Octokit REST API client, MCP GitHub server
  - Authentication: Personal Access Token (GITHUB_TOKEN)
  - Operations: List repositories, create repositories, commit files
  
- **Azure DevOps**: Custom MCP Azure DevOps server
  - Authentication: Personal Access Token (AZURE_DEVOPS_PAT)
  - Organization-scoped access (AZURE_DEVOPS_ORG)
  - Focus on repository operations

**AI Services**:
- **OpenAI API**: GPT-4o-mini model
  - Chat completions for conversational flow
  - Terraform code generation with structured prompts
  - Temperature: 0.7, Max tokens: 2000

**Database**:
- **Neon Serverless PostgreSQL** (configured but not active)
  - Connection via DATABASE_URL environment variable
  - Drizzle ORM for type-safe queries
  - Migration support via drizzle-kit

**Authentication & Session Management**:
- Session-based architecture (no authentication implemented yet)
- Designed for future user authentication with password storage

**Build & Development Tools**:
- Vite for frontend bundling and HMR
- esbuild for server-side bundling
- Replit development plugins (cartographer, dev-banner, runtime error overlay)
- TypeScript compiler for type checking

**Environment Variables Required**:
- `OPENAI_API_KEY`: OpenAI API authentication
- `GITHUB_TOKEN`: GitHub API access
- `GITHUB_OWNER`: GitHub account username
- `AZURE_DEVOPS_ORG`: Azure DevOps organization name
- `AZURE_DEVOPS_PAT`: Azure DevOps personal access token
- `DATABASE_URL`: PostgreSQL connection string (optional, for future use)
- `NODE_ENV`: Environment mode (development/production)

## Implementation Status

### Working Features ✅
1. **Landing Page**: Modern landing interface with cards for Terraform, Kubernetes (coming soon), and Automation Scripting (coming soon)
2. **Session Management**: Create and manage conversation sessions
3. **Provider Selection**: Choose between GitHub and Azure DevOps
4. **Repository Listing**: List existing repositories via MCP
5. **Repository Creation**: Create new GitHub repositories (Azure DevOps requires manual creation)
6. **Cloud Provider Selection**: Choose target cloud platform (Azure, AWS, or GCP)
7. **Module Approach Selection**: Choose between child module, standalone root module, or aggregated root module
8. **AI Conversation**: Natural language interaction with OpenAI GPT-4o-mini
9. **Context-Aware Terraform Generation**: AI-powered generation of main.tf, variables.tf, terraform.tfvars, and README.md based on selected module approach
10. **Code Review**: Monaco editor for reviewing and editing generated files
11. **File Management**: Store and retrieve generated Terraform files
12. **Auto-README**: Automatically generates README.md with usage instructions, cloud provider, and module approach information

### Known Limitations ⚠️

**GitHub MCP push_files Limitation (RESOLVED)**:
The GitHub MCP server's `push_files` tool cannot commit to empty repositories. 

**Solution Implemented**:
- Platform detects "repository is empty" errors in MCP response (checks message, stderr, and data fields)
- Automatically falls back to GitHub REST API (Contents API) when MCP fails on empty repositories
- Files committed sequentially using `createOrUpdateFileContents` endpoint
- Works for all newly created repositories
- 4 files committed: main.tf, variables.tf, terraform.tfvars, and README.md
- README includes usage instructions and cloud provider information

**Azure DevOps MCP Limitations**:
The Azure DevOps MCP server (`@azure-devops/mcp`) has significant functional limitations compared to GitHub:

**Available Tools**:
- `repo_list_repos_by_project` - List repositories in a project ✅
- `repo_create_pull_request` - Create pull requests
- `repo_create_branch` - Create branches
- `repo_get_repo_by_name_or_id` - Get repository details
- Pull request management and review operations

**NOT Supported**:
- ❌ Creating repositories (no `create_repository` tool)
- ❌ Committing files directly (no `push_files` or equivalent)
- ❌ Direct file operations

**Azure DevOps Workflow**:
1. Users must manually create repositories in Azure DevOps first
2. The platform can list existing repositories
3. Users can select a repository and generate Terraform files
4. **Commit step is NOT supported** - users must manually commit generated files via Azure DevOps web UI or git CLI

**Recommendation**: Use GitHub provider for full end-to-end functionality. Azure DevOps integration is limited to repository listing and Terraform generation only.

**End-to-End Functionality**:
- **GitHub**: ✅ Full end-to-end workflow (Landing → Provider → Repository → Cloud → Module → Generate → Review → Commit)
- **Azure DevOps**: ⚠️ Partial workflow (Landing → Provider → Repository → Cloud → Module → Generate → Review). Repository creation and commit steps not supported via MCP - users must manually create repositories and commit generated files.

## Recent Changes

### Module Approach Selection (Latest)
Added a new Step 4 in the workflow to select the module approach before generating Terraform code. This enables:

**Three Module Approaches**:
1. **Child Module** - Generates reusable module code that:
   - Accepts input variables for flexibility
   - Creates specific resources
   - Outputs important values for parent modules
   - Follows module best practices (no provider configuration)
   - Can be called multiple times with different values

2. **Standalone Root Module** - Generates a complete, self-contained configuration that:
   - Defines all resources needed for the infrastructure
   - Includes provider configuration
   - Uses variables for customization
   - Is ready to be applied directly

3. **Aggregated Root Module** - Generates a root module that:
   - Calls multiple child modules (assumes they exist)
   - Includes provider configuration
   - Passes variables to child modules
   - Aggregates outputs from child modules
   - Coordinates the overall infrastructure

**Technical Implementation**:
- Added `moduleApproach` field to session schema ('child-module' | 'standalone-root' | 'aggregated-root')
- Updated step progression from 5 to 6 steps
- Enhanced OpenAI prompts with module-specific context
- Updated generated README.md to include module approach information
- Backend state properly advances to step 6 after Terraform generation