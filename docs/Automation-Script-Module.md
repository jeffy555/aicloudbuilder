# Automation Script Module — Summary Report

## Overview

The Automation Script Module provides **intelligent content analysis and security scanning** for shell scripts, PowerShell scripts, and Python automation files. It extracts meaningful metadata, detects DevOps tool usage, and performs security vulnerability scanning.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Automation Script Analysis Flow                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Script Files (.sh, .ps1, .py) ──► Content Analysis                 │
│                                          │                          │
│         ┌────────────────────────────────┼────────────────────────┐ │
│         ▼                                ▼                        ▼ │
│  ┌──────────────┐               ┌──────────────┐          ┌──────────────┐
│  │ analyzeShell │               │ analyzePower │          │ analyzePython│
│  │    Script    │               │  ShellScript │          │    Script    │
│  └──────┬───────┘               └──────┬───────┘          └──────┬───────┘
│         │                              │                         │ │
│         └──────────────────────────────┼─────────────────────────┘ │
│                                        ▼                           │
│                              ┌──────────────────┐                  │
│                              │  FileDetail      │                  │
│                              │  - path          │                  │
│                              │  - description   │                  │
│                              │  - resources[]   │                  │
│                              └────────┬─────────┘                  │
│                                       │                            │
│                                       ▼                            │
│                              ┌──────────────────┐                  │
│                              │ Security Scanning│                  │
│                              │ (Checkov Runner) │                  │
│                              └────────┬─────────┘                  │
│                                       │                            │
│                                       ▼                            │
│                              ┌──────────────────┐                  │
│                              │ Inventory +      │                  │
│                              │ Findings Report  │                  │
│                              └──────────────────┘                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Supported Script Types

| Type | Extension | Detection |
|------|-----------|-----------|
| **Shell** | `.sh` | Bash, sh, zsh scripts |
| **PowerShell** | `.ps1` | Windows/cross-platform PowerShell |
| **Python** | `.py` | Python automation scripts |

---

## Content Analysis

### Shell Script Analysis (`analyzeShellScript`)

Extracts metadata from `.sh` files:

| Extracted | Pattern | Example |
|-----------|---------|---------|
| **Shebang** | `#!/bin/bash`, `#!/usr/bin/env bash` | `shell: bash` |
| **Error Handling** | `set -e`, `set -euo pipefail` | `error-handling: enabled` |
| **Functions** | `function_name() { }` | `3 function(s)` |
| **DevOps Commands** | `docker`, `kubectl`, `terraform`, `helm`, `aws`, `az`, `gcloud`, `ansible`, `packer`, `vault` | `uses: docker`, `uses: kubectl` |
| **Sourced Files** | `source ./lib.sh`, `. ./common.sh` | `sources: 2 file(s)` |

**Example Output:**
```json
{
  "path": "scripts/deploy.sh",
  "description": "Shell script using docker, kubectl, terraform",
  "resources": [
    "shell: bash",
    "error-handling: enabled",
    "2 function(s)",
    "uses: docker",
    "uses: kubectl",
    "uses: terraform"
  ]
}
```

---

### PowerShell Script Analysis (`analyzePowerShellScript`)

Extracts metadata from `.ps1` files:

| Extracted | Pattern | Example |
|-----------|---------|---------|
| **Module Imports** | `Import-Module Az.Storage` | `module: Az.Storage` |
| **Functions** | `function New-Deployment { }` | `3 function(s)` |
| **Azure Cmdlets** | `Get-Az*`, `New-Az*`, `Set-Az*` | `uses: Azure` |
| **AWS Cmdlets** | `Get-AWS*`, `New-AWS*` | `uses: AWS` |
| **Parameters** | `[CmdletBinding()]`, `[Parameter()]` | `has-parameters` |
| **Error Handling** | `$ErrorActionPreference`, `try { }` | `error-handling: enabled` |

**Example Output:**
```json
{
  "path": "scripts/setup.ps1",
  "description": "PowerShell script for Azure",
  "resources": [
    "module: Az.Storage",
    "module: Az.KeyVault",
    "2 function(s)",
    "uses: Azure",
    "has-parameters",
    "error-handling: enabled"
  ]
}
```

---

### Python Script Analysis (`analyzePythonScript`)

Extracts metadata from `.py` files:

| Extracted | Pattern | Example |
|-----------|---------|---------|
| **Cloud SDKs** | `import boto3`, `from azure.*` | `uses: AWS`, `uses: Azure`, `uses: GCP` |
| **CLI Patterns** | `import argparse`, `import click` | `cli-tool` |
| **Kubernetes** | `import kubernetes` | `uses: kubernetes` |
| **Docker** | `import docker` | `uses: docker` |
| **Ansible** | `import ansible` | `uses: ansible` |
| **Subprocess** | `subprocess.run()`, `os.system()` | `runs-commands` |
| **Main Entry** | `if __name__ == "__main__"` | `has-main` |

**Example Output:**
```json
{
  "path": "tools/migrate.py",
  "description": "Python script for AWS/Azure",
  "resources": [
    "uses: AWS",
    "uses: Azure",
    "cli-tool",
    "runs-commands",
    "has-main"
  ]
}
```

---

## Security Scanning (Checkov)

The module performs security scanning with 9 dedicated checks:

### All Script Types

| Check ID | Severity | Description | Remediation |
|----------|----------|-------------|-------------|
| `CKV_SCRIPT_1` | **Critical** | Hardcoded credentials (password, api_key, secret, token) | Use environment variables or secret management |

### Shell-Specific Checks

| Check ID | Severity | Description | Remediation |
|----------|----------|-------------|-------------|
| `CKV_SCRIPT_2` | **High** | Dangerous `eval` or `exec` with variables | Avoid eval/exec with untrusted input |
| `CKV_SCRIPT_3` | **Medium** | Missing error handling (`set -e`) | Add `set -e` or `set -euo pipefail` |
| `CKV_SCRIPT_4` | **High** | Insecure HTTP requests (`curl -k`, `--insecure`) | Remove insecure flags |

### PowerShell-Specific Checks

| Check ID | Severity | Description | Remediation |
|----------|----------|-------------|-------------|
| `CKV_SCRIPT_5` | **High** | SSL certificate validation disabled | Remove custom validation callbacks |
| `CKV_SCRIPT_6` | **High** | `Invoke-Expression` with variables | Use direct command invocation |

### Python-Specific Checks

| Check ID | Severity | Description | Remediation |
|----------|----------|-------------|-------------|
| `CKV_SCRIPT_7` | **High** | `subprocess` with `shell=True` | Use `shell=False` with argument list |
| `CKV_SCRIPT_8` | **High** | Insecure `pickle` deserialization | Use JSON instead of pickle |
| `CKV_SCRIPT_9` | **High** | SSL verification disabled (`verify=False`) | Remove `verify=False` |

---

## Inventory Summary

The module generates enhanced inventory summaries that include tool detection:

**Before Enhancement:**
```
"3 files detected (2 shell, 1 Python)"
```

**After Enhancement:**
```
"3 files detected (2 shell, 1 Python) - Tools: docker, kubectl, terraform, AWS"
```

### Summary Format

```
{count} files detected ({breakdown}) - Tools: {tools}
```

Where:
- `count` = Total automation scripts
- `breakdown` = Count by type (shell, PowerShell, Python)
- `tools` = Unique DevOps tools detected across all scripts (max 4 shown)

---

## File Structure

| File | Purpose |
|------|---------|
| `server/services/scoreme-service.ts` | Contains `analyzeShellScript`, `analyzePowerShellScript`, `analyzePythonScript` functions |
| `server/services/scoreme/checkov-runner.ts` | Security scanner with `automation` type support |

---

## API Response Example

### Inventory Item

```json
{
  "type": "automation",
  "path": "scripts/deploy.sh",
  "summary": "4 files detected (3 shell, 1 Python) - Tools: docker, kubectl, terraform, AWS",
  "files": [
    "scripts/deploy.sh",
    "scripts/setup.sh",
    "scripts/cleanup.sh",
    "tools/migrate.py"
  ],
  "fileDetails": [
    {
      "path": "scripts/deploy.sh",
      "description": "Shell script using docker, kubectl",
      "resources": ["shell: bash", "error-handling: enabled", "uses: docker", "uses: kubectl"]
    },
    {
      "path": "scripts/setup.sh",
      "description": "Shell script using terraform",
      "resources": ["shell: bash", "uses: terraform", "3 function(s)"]
    },
    {
      "path": "scripts/cleanup.sh",
      "description": "Shell script with 2 function(s)",
      "resources": ["shell: sh", "2 function(s)"]
    },
    {
      "path": "tools/migrate.py",
      "description": "Python script for AWS",
      "resources": ["uses: AWS", "cli-tool", "has-main"]
    }
  ]
}
```

### Security Finding

```json
{
  "category": "Automation",
  "severity": "medium",
  "message": "Shell script does not enable error handling (set -e).",
  "file": "scripts/cleanup.sh",
  "remediation": "Add 'set -e' or 'set -euo pipefail' to fail on errors."
}
```

---

## DevOps Commands Detected

The module detects usage of these DevOps tools:

| Category | Commands |
|----------|----------|
| **Containers** | `docker` |
| **Kubernetes** | `kubectl`, `helm` |
| **Infrastructure** | `terraform`, `packer`, `ansible` |
| **Cloud CLIs** | `aws`, `az`, `gcloud` |
| **Secrets** | `vault` |

---

## Best Practices for Scripts

Based on the security checks, follow these best practices:

### Shell Scripts

```bash
#!/bin/bash
set -euo pipefail  # Enable strict error handling

# Use environment variables for credentials
API_KEY="${API_KEY:?API_KEY is required}"

# Avoid eval with variables
# BAD:  eval "$user_input"
# GOOD: Use direct commands

# Enable SSL verification
curl https://api.example.com  # No -k or --insecure
```

### PowerShell Scripts

```powershell
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$Environment
)

$ErrorActionPreference = "Stop"

# Use environment variables for credentials
$ApiKey = $env:API_KEY

# Avoid Invoke-Expression with variables
# BAD:  Invoke-Expression $userInput
# GOOD: & $command $args
```

### Python Scripts

```python
#!/usr/bin/env python3
import os
import subprocess
import json  # Use JSON instead of pickle

# Use environment variables for credentials
api_key = os.environ.get("API_KEY")

# Avoid shell=True
subprocess.run(["terraform", "plan"], shell=False)

# Enable SSL verification
requests.get("https://api.example.com", verify=True)
```

---

## Integration Points

The Automation Script Module integrates with:

1. **ScoreMe Service** — Provides content analysis for inventory
2. **Checkov Runner** — Provides security vulnerability detection
3. **Report Builder** — Contributes to Security & Compliance pillar scoring

### Scoring Impact

- Each automation script contributes **+5 points** to the "Containerization & Automation" pillar
- Security findings reduce the "Security & Compliance" score by **-4 points per failure**
- Pass rate affects the "Automated Scanning" pillar percentage

---

## Usage

Automation scripts are automatically detected and analyzed when running ScoreMe on a repository:

1. Files matching `.sh`, `.ps1`, `.py` extensions are categorized as automation
2. Content is downloaded and analyzed for metadata extraction
3. Security scanning runs 9 checks per script
4. Results appear in the inventory with detailed file descriptions
5. Security findings appear with actionable remediation guidance

---

## Changelog

| Version | Changes |
|---------|---------|
| 1.0 | Initial implementation — basic file counting |
| 2.0 | Content analysis — extract shebang, functions, DevOps commands |
| 3.0 | Security scanning — 9 Checkov checks for credentials, injection, SSL |
| 3.1 | Enhanced summaries — tool detection in inventory |
