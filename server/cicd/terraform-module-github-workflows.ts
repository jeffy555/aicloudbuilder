/**
 * GitHub Actions workflows for Terraform module workflow (standalone-root & aggregated-root).
 * Mirrors MigrateOps validate/apply shape: init → plan → artifact; optional apply with environment gate.
 * Azure DevOps can be added later (see MigrateOps azure-pipelines pattern).
 */
export function buildGithubTerraformModuleWorkflows(): Array<{ path: string; content: string }> {
  const validateWorkflow = `name: Terraform Module — Validate

on:
  push:
    branches: [main, master]
    paths:
      - '**.tf'
      - '**.tfvars'
      - '.github/workflows/**'
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  validate-terraform:
    name: Validate Terraform (plan)
    runs-on: ubuntu-latest
    env:
      TF_IN_AUTOMATION: "true"
      AZURE_CLIENT_ID: \${{ secrets.AZURE_CLIENT_ID || '' }}
      AZURE_CLIENT_SECRET: \${{ secrets.AZURE_CLIENT_SECRET || '' }}
      AZURE_TENANT_ID: \${{ secrets.AZURE_TENANT_ID || '' }}
      AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID || '' }}
      AZURE_CREDENTIALS: \${{ secrets.AZURE_CREDENTIALS || '' }}
      ARM_CLIENT_ID: \${{ secrets.ARM_CLIENT_ID || '' }}
      ARM_CLIENT_SECRET: \${{ secrets.ARM_CLIENT_SECRET || '' }}
      ARM_TENANT_ID: \${{ secrets.ARM_TENANT_ID || '' }}
      ARM_SUBSCRIPTION_ID: \${{ secrets.ARM_SUBSCRIPTION_ID || '' }}
    defaults:
      run:
        shell: bash
        working-directory: .
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false

      - name: Azure Login (optional)
        if: \${{ env.AZURE_CREDENTIALS != '' }}
        uses: azure/login@v2
        with:
          creds: \${{ env.AZURE_CREDENTIALS }}

      - name: Terraform Init
        run: terraform init -input=false

      - name: Terraform Validate
        run: terraform validate -no-color

      - name: Terraform Plan
        id: plan
        run: |
          set +e
          terraform plan -input=false -out=tfplan -detailed-exitcode
          exit_code=$?
          set -e
          if [ "$exit_code" -eq 1 ]; then
            echo "Terraform plan failed"
            exit 1
          fi
          echo "exit_code=$exit_code" >> "$GITHUB_OUTPUT"

      - name: Export plan summary
        run: |
          terraform show -json tfplan > tfplan.json
          jq '{
            add: ([.resource_changes[]? | select(.change.actions | index("create"))] | length),
            change: ([.resource_changes[]? | select(.change.actions | index("update"))] | length),
            destroy: ([.resource_changes[]? | select(.change.actions | index("delete"))] | length)
          }' tfplan.json > plan-summary.json
          echo "Plan summary:" >> "$GITHUB_STEP_SUMMARY"
          cat plan-summary.json >> "$GITHUB_STEP_SUMMARY"

      - name: Upload tfplan artifact
        uses: actions/upload-artifact@v4
        with:
          name: terraform-module-plan-artifacts
          path: |
            ./tfplan
            ./tfplan.json
            ./plan-summary.json
          if-no-files-found: error

      - name: Summary
        run: |
          if [ "\${{ steps.plan.outputs.exit_code }}" = "0" ]; then
            echo "No infrastructure drift detected." >> "$GITHUB_STEP_SUMMARY"
          else
            echo "Terraform plan completed with pending changes." >> "$GITHUB_STEP_SUMMARY"
          fi
`;

  const applyWorkflow = `name: Terraform Module — Apply

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  validate-terraform:
    name: Validate Terraform (plan)
    runs-on: ubuntu-latest
    env:
      TF_IN_AUTOMATION: "true"
      AZURE_CLIENT_ID: \${{ secrets.AZURE_CLIENT_ID || '' }}
      AZURE_CLIENT_SECRET: \${{ secrets.AZURE_CLIENT_SECRET || '' }}
      AZURE_TENANT_ID: \${{ secrets.AZURE_TENANT_ID || '' }}
      AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID || '' }}
      AZURE_CREDENTIALS: \${{ secrets.AZURE_CREDENTIALS || '' }}
      ARM_CLIENT_ID: \${{ secrets.ARM_CLIENT_ID || '' }}
      ARM_CLIENT_SECRET: \${{ secrets.ARM_CLIENT_SECRET || '' }}
      ARM_TENANT_ID: \${{ secrets.ARM_TENANT_ID || '' }}
      ARM_SUBSCRIPTION_ID: \${{ secrets.ARM_SUBSCRIPTION_ID || '' }}
    defaults:
      run:
        shell: bash
        working-directory: .
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false

      - name: Azure Login (optional)
        if: \${{ env.AZURE_CREDENTIALS != '' }}
        uses: azure/login@v2
        with:
          creds: \${{ env.AZURE_CREDENTIALS }}

      - name: Terraform Init
        run: terraform init -input=false

      - name: Terraform Validate
        run: terraform validate -no-color

      - name: Terraform Plan
        run: terraform plan -input=false -out=tfplan

      - name: Export plan summary
        run: |
          terraform show -json tfplan > tfplan.json
          jq '{
            add: ([.resource_changes[]? | select(.change.actions | index("create"))] | length),
            change: ([.resource_changes[]? | select(.change.actions | index("update"))] | length),
            destroy: ([.resource_changes[]? | select(.change.actions | index("delete"))] | length)
          }' tfplan.json > plan-summary.json
          echo "Plan summary:" >> "$GITHUB_STEP_SUMMARY"
          cat plan-summary.json >> "$GITHUB_STEP_SUMMARY"

      - name: Upload tfplan artifact
        uses: actions/upload-artifact@v4
        with:
          name: terraform-module-plan-artifacts
          path: |
            ./tfplan
            ./tfplan.json
            ./plan-summary.json
          if-no-files-found: error

  apply-terraform:
    name: Apply Terraform (approval required)
    needs: validate-terraform
    runs-on: ubuntu-latest
    environment: terraform-module-apply
    env:
      TF_IN_AUTOMATION: "true"
      AZURE_CLIENT_ID: \${{ secrets.AZURE_CLIENT_ID || '' }}
      AZURE_CLIENT_SECRET: \${{ secrets.AZURE_CLIENT_SECRET || '' }}
      AZURE_TENANT_ID: \${{ secrets.AZURE_TENANT_ID || '' }}
      AZURE_SUBSCRIPTION_ID: \${{ secrets.AZURE_SUBSCRIPTION_ID || '' }}
      AZURE_CREDENTIALS: \${{ secrets.AZURE_CREDENTIALS || '' }}
      ARM_CLIENT_ID: \${{ secrets.ARM_CLIENT_ID || '' }}
      ARM_CLIENT_SECRET: \${{ secrets.ARM_CLIENT_SECRET || '' }}
      ARM_TENANT_ID: \${{ secrets.ARM_TENANT_ID || '' }}
      ARM_SUBSCRIPTION_ID: \${{ secrets.ARM_SUBSCRIPTION_ID || '' }}
    defaults:
      run:
        shell: bash
        working-directory: .
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_wrapper: false

      - name: Azure Login (optional)
        if: \${{ env.AZURE_CREDENTIALS != '' }}
        uses: azure/login@v2
        with:
          creds: \${{ env.AZURE_CREDENTIALS }}

      - name: Download tfplan artifact
        uses: actions/download-artifact@v4
        with:
          name: terraform-module-plan-artifacts
          path: .

      - name: Terraform Init
        run: terraform init -input=false

      - name: Terraform Apply
        run: terraform apply -input=false -auto-approve tfplan
`;

  return [
    { path: '.github/workflows/terraform-module-validate.yml', content: validateWorkflow },
    { path: '.github/workflows/terraform-module-apply.yml', content: applyWorkflow },
  ];
}
