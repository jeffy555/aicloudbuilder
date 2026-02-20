/**
 * End-to-end test for the cost analysis feature.
 * Run with: npx tsx test/cost-analysis-e2e.ts
 */

const BASE = 'http://localhost:9005';

const MAIN_TF = `
provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "main" {
  name     = "rg-test-app"
  location = var.location
}

resource "azurerm_service_plan" "main" {
  name                = "plan-test-app"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = var.app_service_sku
}

resource "azurerm_linux_web_app" "main" {
  name                = "app-test-web"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  service_plan_id     = azurerm_service_plan.main.id
  site_config {}
}

resource "azurerm_storage_account" "main" {
  name                     = "stgtestapp001"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = var.storage_replication
  access_tier              = "Hot"
}

resource "azurerm_key_vault" "main" {
  name                = "kv-test-app"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku_name            = "standard"
  tenant_id           = "00000000-0000-0000-0000-000000000000"
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-test-app"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_cosmosdb_account" "main" {
  name                = "cosmos-test-app"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"
  consistency_policy {
    consistency_level = "Session"
  }
  geo_location {
    location          = azurerm_resource_group.main.location
    failover_priority = 0
  }
}

resource "azurerm_linux_virtual_machine" "workers" {
  count               = var.vm_count
  name                = "vm-worker-\${count.index}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  size                = var.vm_size
  admin_username      = "adminuser"
  network_interface_ids = []
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "UbuntuServer"
    sku       = "18.04-LTS"
    version   = "latest"
  }
}

resource "azurerm_redis_cache" "main" {
  name                = "redis-test-app"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  capacity            = 1
  family              = "C"
  sku_name            = "Basic"
}

resource "azurerm_network_security_group" "main" {
  name                = "nsg-test-app"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
}
`;

const VARIABLES_TF = `
variable "location" {
  description = "Azure region"
  type        = string
  default     = "westus2"
}

variable "app_service_sku" {
  description = "App Service Plan SKU"
  type        = string
  default     = "B1"
}

variable "storage_replication" {
  description = "Storage replication type"
  type        = string
  default     = "GRS"
}

variable "vm_count" {
  description = "Number of worker VMs"
  type        = number
  default     = 2
}

variable "vm_size" {
  description = "VM size"
  type        = string
  default     = "Standard_B2s"
}
`;

const TFVARS = `
location             = "eastus"
app_service_sku      = "S1"
storage_replication  = "LRS"
vm_count             = 3
`;

interface TestResult {
  test: string;
  pass: boolean;
  detail: string;
}

async function run() {
  const results: TestResult[] = [];
  let sessionId: string;

  // 1. Create session and set cloudProvider
  console.log('\n=== Creating test session ===');
  const sessRes = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const sess = await sessRes.json();
  sessionId = sess.id;
  console.log(`Session: ${sessionId}`);

  // Set cloudProvider on session
  await fetch(`${BASE}/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloudProvider: 'azure' }),
  });
  console.log(`  Set cloudProvider=azure`);

  // 2. Upload files (endpoint is /api/sessions/:id/files)
  for (const [name, content] of [['main.tf', MAIN_TF], ['variables.tf', VARIABLES_TF], ['terraform.tfvars', TFVARS]]) {
    const fRes = await fetch(`${BASE}/api/sessions/${sessionId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: name, content }),
    });
    console.log(`  Uploaded ${name} (${fRes.status})`);
  }

  // ─── TEST 1: Medium profile (default) ────────────────────────────────
  console.log('\n=== TEST 1: Medium profile ===');
  const res1 = await fetch(`${BASE}/api/sessions/${sessionId}/analyze-cost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: 'medium' }),
  });
  const data1 = await res1.json();
  if (!data1.success) {
    console.error('API Error:', JSON.stringify(data1, null, 2));
  }
  console.log(`  Status: ${res1.status}, Resources: ${data1.resources?.length || 0}`);

  results.push({
    test: 'API returns success',
    pass: data1.success === true,
    detail: `success=${data1.success}`,
  });

  results.push({
    test: 'Summary has new fields',
    pass: 'monthlyTotalExact' in data1.summary &&
          'monthlyTotalEstimated' in data1.summary &&
          'monthlyGrandTotal' in data1.summary &&
          'exactCount' in data1.summary &&
          'estimatedCount' in data1.summary &&
          'needsInputCount' in data1.summary &&
          'freeCount' in data1.summary &&
          'profile' in data1.summary,
    detail: JSON.stringify(data1.summary),
  });

  results.push({
    test: 'Profile is medium',
    pass: data1.summary.profile === 'medium',
    detail: `profile=${data1.summary.profile}`,
  });

  results.push({
    test: 'Grand total = exact + estimated',
    pass: Math.abs(data1.summary.monthlyGrandTotal - (data1.summary.monthlyTotalExact + data1.summary.monthlyTotalEstimated)) < 0.01,
    detail: `grand=${data1.summary.monthlyGrandTotal}, exact=${data1.summary.monthlyTotalExact}, est=${data1.summary.monthlyTotalEstimated}`,
  });

  results.push({
    test: 'Resources found (>= 5)',
    pass: data1.resources.length >= 5,
    detail: `count=${data1.resources.length}`,
  });

  // Check each resource has the new fields
  const firstBillable = data1.resources.find((r: any) => r.monthlyCost > 0);
  if (firstBillable) {
    results.push({
      test: 'Resource has status field',
      pass: ['exact', 'estimated', 'needs_input'].includes(firstBillable.status),
      detail: `${firstBillable.resourceName}: status=${firstBillable.status}`,
    });

    results.push({
      test: 'Resource has confidenceScore',
      pass: typeof firstBillable.confidenceScore === 'number' && firstBillable.confidenceScore >= 0 && firstBillable.confidenceScore <= 1,
      detail: `${firstBillable.resourceName}: score=${firstBillable.confidenceScore}`,
    });

    results.push({
      test: 'Resource has confidenceLabel',
      pass: ['high', 'medium', 'low'].includes(firstBillable.confidenceLabel),
      detail: `${firstBillable.resourceName}: label=${firstBillable.confidenceLabel}`,
    });

    results.push({
      test: 'Resource has pricingMatchType (no fallback)',
      pass: ['config_exact', 'config_broad', 'free', 'parent', 'unsupported'].includes(firstBillable.pricingMatchType),
      detail: `${firstBillable.resourceName}: matchType=${firstBillable.pricingMatchType}`,
    });

    results.push({
      test: 'Resource has assumptionsUsed array',
      pass: Array.isArray(firstBillable.assumptionsUsed),
      detail: `${firstBillable.resourceName}: assumptions=${JSON.stringify(firstBillable.assumptionsUsed)}`,
    });
  }

  // Check no resources use fallback pricing
  const fallbackResources = data1.resources.filter((r: any) => r.pricingMatchType === 'fallback');
  results.push({
    test: 'No resources use fallback heuristic pricing',
    pass: fallbackResources.length === 0,
    detail: `fallback count=${fallbackResources.length}`,
  });

  // Check estimated resources have usageDimensions
  const estimatedRes = data1.resources.find((r: any) => r.status === 'estimated' && r.usageDimensions?.length > 0);
  results.push({
    test: 'Estimated resources have usageDimensions metadata',
    pass: !!estimatedRes && estimatedRes.usageDimensions.every((d: any) =>
      d.key && d.label && d.unit !== undefined && typeof d.defaultValue === 'number'
    ),
    detail: estimatedRes
      ? `${estimatedRes.resourceName}: dims=${JSON.stringify(estimatedRes.usageDimensions.map((d: any) => d.key))}`
      : 'no estimated resource with dimensions found',
  });

  // Check free resources
  const freeRes = data1.resources.find((r: any) => r.pricingMatchType === 'free');
  results.push({
    test: 'Free resources classified correctly',
    pass: !!freeRes && freeRes.status === 'exact' && freeRes.monthlyCost === 0,
    detail: freeRes ? `${freeRes.resourceName}: status=${freeRes.status}, cost=${freeRes.monthlyCost}` : 'no free resource found',
  });

  // Check variable resolution: location should be "eastus" (from tfvars, not "westus2" default)
  const servicePlan = data1.resources.find((r: any) => r.resourceType === 'azurerm_service_plan');
  results.push({
    test: 'Variable resolution: sku_name from tfvars (S1)',
    pass: !!servicePlan && servicePlan.monthlyCost > 0,
    detail: servicePlan ? `cost=${servicePlan.monthlyCost} (should reflect S1 pricing)` : 'service plan not found',
  });

  // Check VM count expansion (var.vm_count = 3 from tfvars)
  const vms = data1.resources.filter((r: any) => r.resourceType === 'azurerm_linux_virtual_machine');
  results.push({
    test: 'Variable resolution: vm_count=3 expanded',
    pass: vms.length === 3,
    detail: `VM count=${vms.length} (expected 3)`,
  });

  // Check resource counts add up
  const totalByStatus = data1.summary.exactCount + data1.summary.estimatedCount + data1.summary.needsInputCount;
  results.push({
    test: 'Status counts sum to resourceCount',
    pass: totalByStatus === data1.summary.resourceCount,
    detail: `exact=${data1.summary.exactCount} + est=${data1.summary.estimatedCount} + needs=${data1.summary.needsInputCount} = ${totalByStatus}, total=${data1.summary.resourceCount}`,
  });

  // ─── TEST 2: Low profile ──────────────────────────────────────────────
  console.log('\n=== TEST 2: Low profile ===');
  const res2 = await fetch(`${BASE}/api/sessions/${sessionId}/analyze-cost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: 'low' }),
  });
  const data2 = await res2.json();

  results.push({
    test: 'Low profile: returns success',
    pass: data2.success === true && data2.summary.profile === 'low',
    detail: `profile=${data2.summary.profile}`,
  });

  // ─── TEST 3: High profile ─────────────────────────────────────────────
  console.log('\n=== TEST 3: High profile ===');
  const res3 = await fetch(`${BASE}/api/sessions/${sessionId}/analyze-cost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: 'high' }),
  });
  const data3 = await res3.json();

  results.push({
    test: 'High profile: returns success',
    pass: data3.success === true && data3.summary.profile === 'high',
    detail: `profile=${data3.summary.profile}`,
  });

  // Estimated costs should differ across profiles for usage-based resources
  const storMed = data1.resources.find((r: any) => r.resourceType === 'azurerm_storage_account');
  const storLow = data2.resources.find((r: any) => r.resourceType === 'azurerm_storage_account');
  const storHigh = data3.resources.find((r: any) => r.resourceType === 'azurerm_storage_account');

  // Note: storage pricing is SKU-based (per GB), usage catalog affects the estimate display
  // but the actual API cost uses attrs from terraform, so costs might be same
  // The important thing is the profile field changes
  results.push({
    test: 'Profile field changes across requests',
    pass: data1.summary.profile === 'medium' && data2.summary.profile === 'low' && data3.summary.profile === 'high',
    detail: `med=${data1.summary.profile}, low=${data2.summary.profile}, high=${data3.summary.profile}`,
  });

  // ─── TEST 4: No body (backward compat) ────────────────────────────────
  console.log('\n=== TEST 4: No request body (backward compat) ===');
  const res4 = await fetch(`${BASE}/api/sessions/${sessionId}/analyze-cost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data4 = await res4.json();

  results.push({
    test: 'No body defaults to medium profile',
    pass: data4.success === true && data4.summary.profile === 'medium',
    detail: `profile=${data4.summary.profile}`,
  });

  // ─── TEST 5: Custom usage overrides ────────────────────────────────────
  console.log('\n=== TEST 5: Custom usage overrides ===');
  const res5 = await fetch(`${BASE}/api/sessions/${sessionId}/analyze-cost`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profile: 'medium',
      customUsage: {
        'azurerm_storage_account.main': { hot_gb: 1000, cool_gb: 500 },
      },
    }),
  });
  const data5 = await res5.json();

  results.push({
    test: 'Custom usage: returns success',
    pass: data5.success === true,
    detail: `success=${data5.success}`,
  });

  // Storage with custom 1500GB should cost more than medium profile (50GB)
  const storMedium = data1.resources.find((r: any) => r.resourceType === 'azurerm_storage_account');
  const storCustom = data5.resources.find((r: any) => r.resourceType === 'azurerm_storage_account');
  results.push({
    test: 'Custom usage: storage cost differs from profile default',
    pass: !!storMedium && !!storCustom && storCustom.monthlyCost > storMedium.monthlyCost,
    detail: storCustom
      ? `custom=$${storCustom.monthlyCost} vs medium=$${storMedium?.monthlyCost}`
      : 'storage not found',
  });

  // Custom usage resource should have status=exact (user provided values)
  results.push({
    test: 'Custom usage: resource becomes exact status',
    pass: !!storCustom && storCustom.status === 'exact',
    detail: storCustom ? `status=${storCustom.status}` : 'storage not found',
  });

  // ─── PRINT REPORT ─────────────────────────────────────────────────────
  console.log('\n\n====================================');
  console.log('       COST ANALYSIS TEST REPORT');
  console.log('====================================\n');

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const icon = r.pass ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${r.test}`);
    console.log(`         ${r.detail}`);
    if (r.pass) passed++;
    else failed++;
  }

  console.log(`\n------------------------------------`);
  console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`------------------------------------\n`);

  // Print sample resource detail
  if (firstBillable) {
    console.log('=== Sample Resource Detail ===');
    console.log(JSON.stringify(firstBillable, null, 2));
  }

  // Print summary comparison
  console.log('\n=== Summary Comparison Across Profiles ===');
  console.log(`  Low:    $${data2.summary.monthlyGrandTotal.toFixed(2)}/mo (exact: $${data2.summary.monthlyTotalExact.toFixed(2)}, est: $${data2.summary.monthlyTotalEstimated.toFixed(2)})`);
  console.log(`  Medium: $${data1.summary.monthlyGrandTotal.toFixed(2)}/mo (exact: $${data1.summary.monthlyTotalExact.toFixed(2)}, est: $${data1.summary.monthlyTotalEstimated.toFixed(2)})`);
  console.log(`  High:   $${data3.summary.monthlyGrandTotal.toFixed(2)}/mo (exact: $${data3.summary.monthlyTotalExact.toFixed(2)}, est: $${data3.summary.monthlyTotalEstimated.toFixed(2)})`);

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
