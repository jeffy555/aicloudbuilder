# ArchMe Azure Cost Analyzer - Validation Phase

## Goal
Validate that Azure cost results are SKU-driven, reproducible, and transparent.

## Scope
- Azure Terraform only (`azurerm_*`)
- Generated code path (`main.tf`, `variables.tf`, `terraform.tfvars`)
- API + UI behavior

## Validation Layers

### 1) Unit formula tests
Validate per:
- hour
- second
- GB-month
- operations

Ensure `unitOfMeasure` mapping is correct.

### 2) SKU match tests
For known fixtures:
- Verify extracted SKU/tier/capacity
- Verify query filters and selected meter
- Expect `pricingMatchType=exact_sku_match`

### 3) Variable resolution tests
Test values from:
- literals
- variable defaults
- tfvars overrides

Ensure resolved values appear in `providedUsage`.

### 4) Missing usage behavior
For incomplete usage-based resources:
- must return `needs_input`
- must list `requiredUsageFields`
- must not silently inject fake cost

### 5) Profile estimation tests
Verify low/medium/high/custom:
- defaults applied correctly
- custom overrides defaults
- status = `estimated` when defaults used

### 6) API contract tests
Validate response schema stability:
- summary fields present
- status on all resources
- confidence metadata present

### 7) UI tests
Validate:
- badges (`Exact`, `Estimated`, `Needs input`)
- totals split correctly
- usage input flow recalculates totals
- no misleading `0` for missing costs

### 8) Regression/safety
Validate:
- malformed Terraform handling
- pricing API timeout/failure handling
- graceful degradation

## Test Fixtures
1. `exact-only`
2. `mixed`
3. `needs-input`
4. `large-stack`

## Metrics
- exact match rate
- estimated rate
- needs-input rate
- SKU miss rate
- API failure rate
- recalc latency (P50/P95)

## Release Gate
Do not release unless:
- 0 silent skips
- 0 random fallback costs
- fixture totals match expected baselines
- UI clearly differentiates exact vs estimated

## Post-Release Monitoring
- Alert on SKU miss spikes
- Track top unmatched resource types
- Weekly calibration on benchmark stacks
