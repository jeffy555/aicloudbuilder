# ScoreMe Module — Summary Report

## Overview

ScoreMe is a **confidence reporting tool** for Infrastructure-as-Code (IaC) repositories. It analyzes DevOps-related files from GitHub or Azure DevOps repos, runs security scans, and produces a weighted score with actionable remediation guidance.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ScoreMe Flow                                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  User selects repo ──► POST /api/scoreme/run                        │
│                              │                                      │
│                              ▼                                      │
│                    ┌─────────────────┐                              │
│                    │ ScoreMeService  │                              │
│                    └────────┬────────┘                              │
│                             │                                       │
│         ┌───────────────────┼───────────────────┐                   │
│         ▼                   ▼                   ▼                   │
│   ┌──────────┐       ┌──────────┐       ┌──────────────┐            │
│   │  GitHub  │       │  Azure   │       │  Bitwarden   │            │
│   │   API    │       │  DevOps  │       │  (credentials)│           │
│   └────┬─────┘       └────┬─────┘       └──────────────┘            │
│        │                  │                                         │
│        └────────┬─────────┘                                         │
│                 ▼                                                   │
│        ┌───────────────┐                                            │
│        │ categorizePaths│ ──► Intelligent file detection            │
│        └───────┬───────┘                                            │
│                ▼                                                    │
│        ┌───────────────┐                                            │
│        │ ensureFiles   │ ──► Download content (max 120/category)    │
│        └───────┬───────┘                                            │
│                ▼                                                    │
│        ┌───────────────┐                                            │
│        │ Checkov Scan  │ ──► Terraform, Kubernetes, Dockerfile,     │
│        │               │     Automation Scripts                     │
│        └───────┬───────┘                                            │
│                ▼                                                    │
│        ┌───────────────┐                                            │
│        │ buildReport   │ ──► Weighted scoring + findings            │
│        └───────┬───────┘                                            │
│                ▼                                                    │
│        ScoreMeReport JSON ──► Frontend renders + HTML export        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## File Detection — Intelligent Categorization

| Category | Detection Logic |
|----------|-----------------|
| **Terraform** | `.tf`, `.tf.json` |
| **Bicep** | `.bicep` |
| **ARM Templates** | `azuredeploy.json`, `maintemplate.json`, `*.arm.json`, `arm-*.json`, `deploy*.json`, `template.json` |
| **Kubernetes** | Smart detection: must be in k8s-related path (`k8s/`, `kubernetes/`, `manifests/`, `deploy/`, `helm/`, `charts/`) OR have k8s-specific filename (`deployment.yaml`, `service.yaml`, `ingress.yaml`, etc.). Excludes CI/CD paths (`.github/`, `.gitlab/`, `.azure-pipelines/`, etc.) |
| **Helm** | `chart.yaml`, `values.yaml`, `/templates/*.yaml` |
| **Dockerfile** | `Dockerfile`, `Dockerfile.*` |
| **Docker Compose** | `docker-compose*.yaml`, `compose.yaml` |
| **Automation** | `.sh`, `.ps1`, `.py` — with intelligent content analysis |

---

## Content Analysis — Intelligent File Understanding

ScoreMe analyzes file contents to extract meaningful metadata for inventory descriptions.

### Terraform Analysis (`analyzeTerraformFile`)

| Extracted | Pattern |
|-----------|---------|
| Resources | `resource "type" "name"` |
| Data Sources | `data "type" "name"` |
| Modules | `module "name"` |
| Providers | `provider "name"` |
| Variables | `variable "name"` count |
| Outputs | `output "name"` count |

**Example Output:** `"Defines 5 resource(s): azurerm_storage_account, azurerm_resource_group..."`

### Kubernetes Analysis (`analyzeKubernetesFile`)

| Extracted | Pattern |
|-----------|---------|
| Kind | `kind: Deployment` |
| Name | `metadata.name` |
| Namespace | `metadata.namespace` |
| Multi-doc | Splits by `---` for multi-resource files |

**Example Output:** `"3 resources: Deployment, Service, ConfigMap"`

### Helm Analysis (`analyzeHelmFile`)

| File | Extracted |
|------|-----------|
| `Chart.yaml` | Chart name, version, dependencies |
| `values.yaml` | Configuration section count |
| `/templates/*` | Analyzed as Kubernetes templates |

**Example Output:** `"Chart: my-app v1.2.0"` or `"Values file with 12 configuration section(s)"`

### Automation Script Analysis

| Script Type | Function | Extracted |
|-------------|----------|-----------|
| **Shell (.sh)** | `analyzeShellScript` | Shebang, error handling (`set -e`), functions, DevOps commands (docker, kubectl, terraform, helm, aws, az, gcloud, ansible, packer, vault), sourced files |
| **PowerShell (.ps1)** | `analyzePowerShellScript` | Module imports, functions, Azure/AWS cmdlets, parameters, error handling |
| **Python (.py)** | `analyzePythonScript` | Imports, cloud SDKs (boto3, azure, google), CLI patterns (argparse, click), subprocess usage, main entry point, infrastructure libraries |

**Example Outputs:**
- Shell: `"Shell script using docker, kubectl, terraform"`
- PowerShell: `"PowerShell script for Azure"` or `"PowerShell with Az.Storage, Az.KeyVault"`
- Python: `"Python script for AWS/Azure"` or `"Python CLI tool"`

### Inventory Summary Enhancement

Automation scripts now include tool detection in summaries:

**Before:** `"3 files detected (2 shell, 1 Python)"`

**After:** `"3 files detected (2 shell, 1 Python) - Tools: docker, kubectl, terraform, AWS"`

---

## Security Scanning (Checkov)

| Framework | Checks Performed |
|-----------|------------------|
| **Terraform** | `CKV_TERRAFORM_1` (public access enabled), `CKV_TERRAFORM_2` (missing tags) |
| **Kubernetes** | `CKV_K8S_1` (missing readiness probe), `CKV_K8S_2` (hostNetwork enabled) |
| **Dockerfile** | `CKV_DOCKER_1` (`:latest` tag), `CKV_DOCKER_2` (runs as root), `CKV_DOCKER_3` (missing HEALTHCHECK) |
| **Automation** | See Automation Script Security Checks below |

### Automation Script Security Checks

| Check ID | Severity | Script Type | Description |
|----------|----------|-------------|-------------|
| `CKV_SCRIPT_1` | Critical | All | Hardcoded credentials (password, api_key, secret, token) |
| `CKV_SCRIPT_2` | High | Shell | Dangerous `eval` or `exec` with variables |
| `CKV_SCRIPT_3` | Medium | Shell | Missing error handling (`set -e`) |
| `CKV_SCRIPT_4` | High | Shell | Insecure HTTP requests (`curl -k`, `wget --no-check-certificate`) |
| `CKV_SCRIPT_5` | High | PowerShell | SSL certificate validation disabled |
| `CKV_SCRIPT_6` | High | PowerShell | `Invoke-Expression` with variables (code injection risk) |
| `CKV_SCRIPT_7` | High | Python | `subprocess` with `shell=True` (shell injection risk) |
| `CKV_SCRIPT_8` | High | Python | Insecure `pickle` deserialization |
| `CKV_SCRIPT_9` | High | Python | SSL verification disabled (`verify=False`) |

---

## Scoring Pillars

| Pillar | Weight | Calculation |
|--------|--------|-------------|
| **Security & Compliance** | 40% | `100 - (failed_checks × 4)` — penalizes Checkov failures |
| **Infrastructure Coverage** | 25% | `50 + (infra_files × 5)` — rewards Terraform/Bicep/ARM/K8s/Helm coverage |
| **Automated Scanning** | 20% | `(passed / total) × 100` — Checkov pass rate |
| **Containerization & Automation** | 15% | `50 + (containers × 10) + (scripts × 5) + (helm × 5)` |

### Confidence Levels

| Score Range | Confidence Level |
|-------------|------------------|
| 90–100% | `Production-ready` |
| 70–89% | `Needs minor fixes` |
| 50–69% | `Risky` |
| < 50% | `Not recommended` |

### Special Cases

| Condition | Confidence Level | Score |
|-----------|------------------|-------|
| Empty repository (no files) | `Empty Repository` | 0% |
| Application code only (no IaC) | `Application Code Only` | 0% |
| No DevOps files found | `Not recommended` | 0% |

---

## API Contract

### Endpoint

`POST /api/scoreme/run`

### Request

```json
{
  "provider": "github" | "azure",
  "repositoryId": "string",
  "repositoryName": "string",
  "repositoryFullName": "owner/repo",
  "branch": "main"
}
```

### Response (`ScoreMeReport`)

```json
{
  "repository": "owner/repo",
  "provider": "github",
  "inventory": [
    {
      "type": "terraform",
      "path": "infra/main.tf",
      "summary": "5 files detected - Resources: azurerm_storage_account, azurerm_resource_group",
      "files": [...],
      "fileDetails": [
        { "path": "infra/main.tf", "description": "Defines 3 resource(s): azurerm_storage_account...", "resources": [...] }
      ]
    },
    {
      "type": "kubernetes",
      "path": "k8s/deployment.yaml",
      "summary": "3 files detected - Kinds: Deployment, Service, ConfigMap",
      "files": [...]
    },
    {
      "type": "automation",
      "path": "scripts/deploy.sh",
      "summary": "4 files detected (3 shell, 1 Python) - Tools: docker, kubectl, terraform",
      "files": [...],
      "fileDetails": [
        { "path": "scripts/deploy.sh", "description": "Shell script using docker, kubectl", "resources": ["shell: bash", "error-handling: enabled", "uses: docker", "uses: kubectl"] },
        { "path": "tools/migrate.py", "description": "Python script for AWS", "resources": ["uses: AWS", "cli-tool", "has-main"] }
      ]
    }
  ],
  "findings": [
    { "category": "Terraform", "severity": "high", "message": "...", "file": "...", "remediation": "..." },
    { "category": "Automation", "severity": "medium", "message": "Shell script does not enable error handling", "file": "scripts/setup.sh", "remediation": "Add 'set -e' or 'set -euo pipefail' to fail on errors." }
  ],
  "pillarScores": [
    { "name": "Security & Compliance", "score": 84, "weight": 0.4, "details": ["Terraform: 1 failed, 4 passed", "Automation: 1 failed, 3 passed"] }
  ],
  "finalScore": 78.5,
  "confidence": "Needs minor fixes",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

---

## File Structure

| File | Purpose |
|------|---------|
| `client/src/pages/ScoreMe.tsx` | React UI — repo picker, report display, HTML download |
| `server/routes/scoreme.ts` | Route registration — `POST /api/scoreme/run` |
| `server/services/scoreme-service.ts` | Core logic — file categorization, API calls, report building |
| `server/services/scoreme/checkov-runner.ts` | Security scanner — regex-based checks for Terraform/K8s/Docker/Automation |
| `shared/schema.ts` | Zod schemas — `ScoreMeReport`, `ScoreMeFinding`, `ScoreMeInventory`, `ScoreMePillar` |

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Multi-provider** | Supports GitHub and Azure DevOps repositories |
| **Smart YAML filtering** | Excludes CI/CD pipelines and IDE configs from Kubernetes detection |
| **Multi-IaC support** | Terraform, Bicep, ARM, Kubernetes, Helm, Docker |
| **Automation scripts** | Shell, PowerShell, Python with content analysis and security scanning |
| **Content analysis** | Intelligent parsing extracts resources, kinds, tools from file contents |
| **Security findings** | Actionable remediation guidance per finding (14 check types) |
| **Weighted scoring** | Balanced assessment across security, coverage, automation |
| **Empty repo detection** | Special handling for empty and application-only repositories |
| **HTML export** | Downloadable styled report for sharing |
| **File limits** | Max 120 files per category to prevent timeouts |

---

## Credential Management

Credentials are fetched at runtime via **Bitwarden integration** — not stored in environment variables:

```
bitwardenService.getAllUserSecrets(userId)
  └─► secrets.github.token / secrets.github.owner
  └─► secrets.azureDevOps.pat / secrets.azureDevOps.org / secrets.azureDevOps.project
```

---

## Enhancement History

| Phase | Enhancement |
|-------|-------------|
| Initial | Basic Terraform + Kubernetes scanning |
| + Bicep/ARM | Added Azure-native IaC detection |
| + Smart K8s | Intelligent YAML filtering (excludes CI/CD) |
| + Docker | Dockerfile + Docker Compose detection + security checks |
| + Scoring | Refined 4-pillar weighted scoring model |
| + Content Analysis | Intelligent file parsing for Terraform, Kubernetes, Helm |
| + Empty Repo | Detection for empty repos and application-only repos |
| + Automation Scripts | Full content analysis + 9 security checks for Shell/PowerShell/Python |

---

## Usage

1. Navigate to **ScoreMe** from the landing page
2. Select your repository provider (GitHub or Azure DevOps)
3. Choose a repository from the list
4. Click **Run ScoreMe**
5. Review the confidence report with:
   - Pillar scores breakdown
   - Security findings with remediation
   - File inventory by category
6. Optionally download the HTML report for sharing
