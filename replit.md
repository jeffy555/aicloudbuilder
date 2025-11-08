# AI-Driven DevOps Platform

## Overview
This AI-powered DevOps automation platform enables users to generate and commit Terraform configurations through natural language conversations. The platform aims to streamline DevOps workflows by providing AI-driven assistance for infrastructure as code (IaC) generation, with planned expansions to include Kubernetes and automation scripting. It guides users through a structured workflow to select providers, repositories, cloud platforms, and module approaches, culminating in the generation and commitment of Terraform code. The platform integrates OpenAI's GPT-4o-mini and the Model Context Protocol (MCP) for efficient repository management.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### UI/UX Decisions
The platform features a modern, clean UI inspired by Linear and GitHub, designed with an AI-first approach. Key UI patterns include a seven-step wizard flow, a conversational chat interface, a multi-file tabbed code editor, and clear action buttons for commit operations. The design emphasizes responsive layouts and code-centric components, leveraging Radix UI primitives and shadcn/ui (New York style) with custom theming and Tailwind CSS for a hybrid aesthetic combining modern developer patterns with GitHub's DevOps style.

### Technical Implementations
The frontend is built with React 18, TypeScript, and Vite, using Wouter for routing and TanStack Query for server state management. The backend uses Node.js with Express.js and TypeScript, exposing RESTful APIs for session, message, file generation, repository, and commit operations. AI integration relies on OpenAI GPT-4o-mini for conversational AI and context-aware Terraform generation, supporting different module approaches (Child Module, Standalone Root Module, Aggregated Root Module). Repository integration is managed through the Model Context Protocol (MCP) client manager, abstracting operations for GitHub and Azure DevOps using spawned child processes. Data persistence is currently in-memory but designed for PostgreSQL via Drizzle ORM.

### Feature Specifications
The platform supports a structured seven-step workflow:
1.  **Landing Page**: Automation type selection.
2.  **Provider Selection**: Choice between GitHub and Azure DevOps.
3.  **Repository Selection**: Option to choose or create a repository, with automatic scanning for existing Terraform configurations to adapt the workflow.
4.  **Cloud Provider Selection**: Selection among Azure, AWS, or GCP.
5.  **Module Approach Selection**: Choose from Child Module, Standalone Root Module, or Aggregated Root Module for Terraform generation, with specific validation rules for each (e.g., Child Modules generate `resource` blocks and are organized by resource type in folders).
6.  **Backend Configuration** (Root Modules Only): Configure Terraform backend for state management. The system now features automatic backend detection and provisioning:
    -   **Automatic Detection**: Scans repository for existing backend.tf during repository selection
    -   **Auto-Validation** (Azure + GitHub): If backend.tf exists, automatically validates that all Azure resources (resource group, storage account, container) exist using Azure MCP
    -   **Auto-Creation** (Azure only): If backend.tf doesn't exist and Azure is the cloud provider, automatically provisions real Azure resources in the correct order:
        1. Resource Group (e.g., `terraform-state-rg`)
        2. Storage Account (e.g., `tfstate12345678`)
        3. Blob Container (e.g., `tfstate`)
    -   **Manual Options** (AWS/GCP or fallback): For non-Azure clouds or if auto-actions fail, shows manual options to create, skip, or validate
    
    This step is skipped for child modules, which inherit backend configuration from their parent. The generated backend.tf references actual provisioned Azure resources, allowing users to run `terraform init` immediately after commit. Backend configuration is validated/created before Terraform generation, with workflow gating that prevents generation until backend is properly configured or explicitly declined.
7.  **Terraform Generation**: Natural language description for infrastructure. Generated files are organized into separate files:
    -   **backend.tf**: Backend configuration (if configured in step 6)
    -   **provider.tf**: Provider configuration and version requirements
    -   **main.tf**: Resource definitions
    -   **variables.tf**: Input variable declarations
    -   **terraform.tfvars**: Variable values
    -   **outputs.tf**: Output values
8.  **Review & Commit**: Review, edit, and commit generated Terraform files. This step includes a structured file browser, code preview, and integrated Checkov security scanning with commit gating that requires a scan before committing.

## External Dependencies

### Repository Providers
-   **GitHub**: Utilizes Octokit REST API client and MCP GitHub server for repository listing, creation, and file commits.
-   **Azure DevOps**: Uses Azure DevOps MCP server (`@azure-devops/mcp`) for repository listing.
-   **Azure Resources**: Uses Azure MCP server (`@azure/mcp`) for managing Azure resources and validating Terraform backend configurations like storage accounts and containers.

### AI Services
-   **OpenAI API**: Employs the GPT-4o-mini model for chat completions and structured Terraform code generation.

### Database
-   **Neon Serverless PostgreSQL**: Configured for future data persistence, integrated with Drizzle ORM.

### Build & Development Tools
-   **Vite**: Frontend bundling and Hot Module Replacement.
-   **esbuild**: Server-side bundling.