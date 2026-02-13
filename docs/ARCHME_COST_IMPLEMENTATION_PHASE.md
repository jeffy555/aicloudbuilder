# ArchMe Azure Cost Analyzer - Implementation Phase

## Goal
Implement Azure-only, SKU-driven cost analysis from generated Terraform (`main.tf`, `variables.tf`, `terraform.tfvars`) using Azure Retail Pricing API.

## Scope
- Azure resources only (`azurerm_*`)
- Cost states: `exact`, `estimated`, `needs_input`
- No random fallback costs

## Deliverables
1. SKU-locked pricing resolver.
2. Usage-dimension catalog for usage-based services.
3. API response with confidence and assumptions metadata.
4. UI updates for exact/estimated/needs-input.

## Steps

### 1) Response contract
Add:
- `summary.monthlyTotalExact`
- `summary.monthlyTotalEstimated`
- `summary.monthlyGrandTotal`
- `summary.exactCount`, `estimatedCount`, `needsInputCount`
- Per resource: `status`, `pricingMatchType`, `requiredUsageFields`, `providedUsage`, `assumptionsUsed`, `confidenceLabel`, `confidenceScore`.

### 2) Usage-dimension catalog
Create server mapping by resource type:
- `azurerm_storage_account`: `hot_gb`, `cool_gb`, `transactions_10k`, `egress_gb`
- `azurerm_key_vault`: `operations_10k`
- `azurerm_log_analytics_workspace`: `ingestion_gb_day`, `retention_days`
- `azurerm_cosmosdb_account`: `ru_per_sec`, `storage_gb`
- `azurerm_cdn_frontdoor_*`: `requests_million`, `egress_gb`

Include low/medium/high defaults.

### 3) Strict SKU matching
Resolve from Terraform attrs: `sku_name`, `tier`, `capacity`, `region`, redundancy.
Use Azure Retail API filters with `serviceName`, `armRegionName`, `armSkuName`, `priceType=Consumption`.
If no reliable match: `needs_input` or `estimated` only.

### 4) Fix unit handling
Use `unitOfMeasure`-aware formulas:
- hour-based
- second-based
- GB-month
- operation-based

### 5) Resolve variable values first
Resolve in order:
1. `terraform.tfvars`
2. `variables.tf` defaults
3. literals in `main.tf`

Unresolved required usage -> `needs_input`.

### 6) Profile-based estimation
Support request payload:
- `profile: low|medium|high|custom`
- `customUsage` per resource address

Defaults = `estimated`; custom values override.

### 7) UI updates
- Summary cards: exact/estimated/needs-input
- Resource table with status badges
- "Provide usage" action for `needs_input`
- Profile selector + recalc

### 8) Logging and observability
Log SKU misses, unresolved variables, and unsupported resources.

## Definition of Done
- No silent skips.
- No random fallback values.
- Every resource classified into `exact|estimated|needs_input`.
- Totals are traceable to SKU + formula + assumptions.
