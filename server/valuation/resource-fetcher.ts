/**
 * Azure Resource Fetcher for Valuation Module
 *
 * Fetches ALL live Azure resources using Azure REST API.
 * Uses Azure Management API to list all resources in subscription.
 */

import { mcpClient } from '../mcp-client';
import { bitwardenService } from '../services/bitwarden-service';
import { fetchActualCosts, getMonthToDatePeriod } from './cost-management';
import type { AzureResource, ResourceGroupSummary } from '@shared/schema';

/**
 * Get Azure access token using Service Principal credentials
 */
async function getAzureAccessToken(): Promise<string> {
  const clientId = process.env.AZURE_CLIENT_ID!;
  const clientSecret = process.env.AZURE_CLIENT_SECRET!;
  const tenantId = process.env.AZURE_TENANT_ID!;

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://management.azure.com/.default',
    grant_type: 'client_credentials'
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Azure access token: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Azure REST api-version per resource provider — generic versions often return 400 or empty template.
 * MigrateOps needs full `properties` (e.g. Container Apps template.containers[].resources).
 */
function apiVersionForResourceType(resourceType: string | undefined): string {
  const t = (resourceType || '').toLowerCase();
  if (t.includes('microsoft.app/containerapps')) return '2024-03-01';
  if (t.includes('microsoft.app/managedenvironments')) return '2024-03-01';
  if (t.includes('microsoft.app/managedenvironments/certificates')) return '2024-03-01';
  if (t.includes('microsoft.containerregistry')) return '2023-07-01';
  if (t.includes('microsoft.operationalinsights')) return '2022-10-01';
  if (t.includes('microsoft.network')) return '2023-05-01';
  if (t.includes('microsoft.storage')) return '2023-01-01';
  if (t.includes('microsoft.resources')) return '2024-03-01';
  return '2023-01-01';
}

/**
 * Fetch detailed properties for a specific resource
 */
async function fetchResourceDetails(
  resourceId: string,
  accessToken: string,
  resourceType?: string
): Promise<any> {
  const primaryVersion = apiVersionForResourceType(resourceType);
  const tryVersions = [primaryVersion, '2023-01-01'];

  for (const apiVersion of tryVersions) {
    const apiUrl = `https://management.azure.com${resourceId}?api-version=${apiVersion}`;
    try {
      const response = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        return await response.json();
      }
    } catch {
      // try next version
    }
  }

  return null;
}

/**
 * Loads Azure credentials from Bitwarden (with fallback to env vars)
 * and sets them as environment variables for MCP client
 */
async function loadAzureCredentials(userId?: string): Promise<boolean> {
  try {
    // Try Bitwarden first if userId provided
    if (userId) {
      console.log('🔑 Fetching Azure credentials from Bitwarden...');
      const azureSecret = await bitwardenService.getUserSecret(userId, 'azure-cloud');

      if (azureSecret) {
        console.log('✅ Found Azure credentials in Bitwarden');
        process.env.AZURE_CLIENT_ID = azureSecret.clientId;
        process.env.AZURE_CLIENT_SECRET = azureSecret.clientSecret;
        process.env.AZURE_TENANT_ID = azureSecret.tenantId;
        process.env.AZURE_SUBSCRIPTION_ID = azureSecret.subscriptionId;
        return true;
      }
      console.log('⚠️  No Azure credentials found in Bitwarden, checking environment variables...');
    }

    // Fallback to environment variables
    const hasEnvVars = !!(
      process.env.AZURE_CLIENT_ID &&
      process.env.AZURE_CLIENT_SECRET &&
      process.env.AZURE_TENANT_ID &&
      process.env.AZURE_SUBSCRIPTION_ID
    );

    if (hasEnvVars) {
      console.log('✅ Using Azure credentials from environment variables');
      return true;
    }

    console.error('❌ No Azure credentials found in Bitwarden or environment variables');
    return false;
  } catch (error: any) {
    console.error('❌ Failed to load Azure credentials:', error.message);
    // Check if env vars are available as fallback
    return !!(
      process.env.AZURE_CLIENT_ID &&
      process.env.AZURE_CLIENT_SECRET &&
      process.env.AZURE_TENANT_ID &&
      process.env.AZURE_SUBSCRIPTION_ID
    );
  }
}

/**
 * Azure does not include the resource group resource in .../resourceGroups/{name}/resources.
 * MigrateOps must read the RG's own location from ARM or inferred location may use a child
 * resource's region (e.g. centralus) that differs from the RG (e.g. centralindia).
 */
export async function fetchResourceGroupLocation(
  userId: string | undefined,
  subscriptionId: string,
  resourceGroupName: string
): Promise<string | null> {
  const sub = String(subscriptionId || '').trim();
  const name = String(resourceGroupName || '').trim();
  if (!sub || !name) return null;

  try {
    const hasCredentials = await loadAzureCredentials(userId);
    if (!hasCredentials) return null;

    const accessToken = await getAzureAccessToken();
    const enc = encodeURIComponent(name);
    const apiUrl = `https://management.azure.com/subscriptions/${sub}/resourcegroups/${enc}?api-version=2021-04-01`;

    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(
        `[Azure] Resource group metadata GET failed for "${name}": ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = (await response.json()) as { location?: string };
    const raw = String(data?.location || '').trim();
    if (!raw || raw.toLowerCase() === 'global') return null;
    return raw.toLowerCase().replace(/\s+/g, '');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[Azure] fetchResourceGroupLocation failed: ${msg}`);
    return null;
  }
}

/**
 * Fetch all resource groups in the subscription
 * Returns array of ResourceGroupSummary with resource counts
 */
export async function fetchResourceGroups(userId?: string): Promise<ResourceGroupSummary[]> {
  try {
    // Load Azure credentials
    const hasCredentials = await loadAzureCredentials(userId);
    if (!hasCredentials) {
      throw new Error('Azure credentials not configured');
    }

    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
    const accessToken = await getAzureAccessToken();

    console.log('   📦 Fetching resource groups...');

    const apiUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourcegroups?api-version=2021-04-01`;

    const response = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to fetch resource groups: ${response.status} ${error}`);
    }

    const data = await response.json();
    const resourceGroups = data.value || [];

    console.log(`   ✅ Found ${resourceGroups.length} resource group(s)`);

    // For each RG, fetch resource count (with rate limiting)
    const summaries: ResourceGroupSummary[] = [];
    const batchSize = 5; // Process 5 RGs at a time to avoid rate limiting

    for (let i = 0; i < resourceGroups.length; i += batchSize) {
      const batch = resourceGroups.slice(i, i + batchSize);

      const batchResults = await Promise.all(
        batch.map(async (rg: any) => {
          const rgName = rg.name;
          const resourcesUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rgName}/resources?api-version=2021-04-01`;

          try {
            const resourcesResponse = await fetch(resourcesUrl, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              }
            });

            if (!resourcesResponse.ok) {
              console.warn(`   ⚠️  Could not fetch resources for ${rgName}: ${resourcesResponse.status}`);
              return {
                id: rg.id,
                name: rgName,
                location: rg.location,
                resourceCount: 0,
                tags: rg.tags
              };
            }

            const resourcesData = await resourcesResponse.json();
            const resourceCount = (resourcesData.value || []).length;

            return {
              id: rg.id,
              name: rgName,
              location: rg.location,
              resourceCount,
              tags: rg.tags
            };
          } catch (error: any) {
            console.warn(`   ⚠️  Error fetching resources for ${rgName}: ${error.message}`);
            return {
              id: rg.id,
              name: rgName,
              location: rg.location,
              resourceCount: 0,
              tags: rg.tags
            };
          }
        })
      );

      summaries.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < resourceGroups.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    console.log(`   ✅ Successfully fetched details for ${summaries.length} resource group(s)`);
    return summaries;

  } catch (error: any) {
    console.error('❌ Failed to fetch resource groups:', error);
    throw new Error(`Resource group fetch failed: ${error.message}`);
  }
}

/**
 * Fetch resources from specific resource groups only
 * @param resourceGroupIds - Array of resource group IDs to fetch from
 */
async function fetchResourcesFromResourceGroups(
  resourceGroupIds: string[],
  accessToken: string,
  subscriptionId: string
): Promise<any[]> {
  console.log(`   🔍 Fetching resources from ${resourceGroupIds.length} selected resource group(s)...`);

  const allResources: any[] = [];

  // Extract resource group names from IDs
  const rgNames = resourceGroupIds.map(id => {
    const parts = id.split('/resourceGroups/');
    return parts[1] || id;
  });

  // Fetch resources from each selected resource group
  for (const rgName of rgNames) {
    const apiUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rgName}/resources?api-version=2021-04-01`;

    try {
      const response = await fetch(apiUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.warn(`   ⚠️  Failed to fetch resources from ${rgName}: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const resources = data.value || [];
      allResources.push(...resources);
      console.log(`      • ${rgName}: ${resources.length} resource(s)`);

    } catch (error: any) {
      console.warn(`   ⚠️  Error fetching resources from ${rgName}:`, error.message);
    }
  }

  console.log(`   ✅ Found ${allResources.length} total resources in selected resource groups`);
  return allResources;
}

/**
 * Fetches ALL Azure resources from subscription
 * Uses Azure REST API to get complete resource inventory
 * @param userId - Optional user ID for credential lookup
 * @param resourceGroupIds - Optional array of resource group IDs to filter by
 */
export async function fetchAzureResources(
  userId?: string,
  resourceGroupIds?: string[]
): Promise<AzureResource[]> {
  try {
    // Load Azure credentials from Bitwarden or env
    const hasCredentials = await loadAzureCredentials(userId);
    if (!hasCredentials) {
      throw new Error('Azure credentials not configured. Please configure them in Settings or set environment variables.');
    }

    const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
    const accessToken = await getAzureAccessToken();

    let azureResources: any[];

    // If resource groups specified, fetch only from those RGs
    if (resourceGroupIds && resourceGroupIds.length > 0) {
      console.log(`\n🔍 Fetching resources from ${resourceGroupIds.length} selected resource group(s)...`);
      azureResources = await fetchResourcesFromResourceGroups(resourceGroupIds, accessToken, subscriptionId);
    } else {
      // Otherwise fetch all resources from entire subscription
      console.log('\n🔍 Fetching ALL resources from subscription...');
      const apiUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resources?api-version=2021-04-01`;

      const response = await fetch(apiUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Azure REST API failed: ${response.status} ${error}`);
      }

      const data = await response.json();
      azureResources = data.value || [];
      console.log(`   ✅ Found ${azureResources.length} total resources in subscription`);
    }

    // Fetch actual costs from Azure Cost Management (month-to-date)
    console.log('   💰 Fetching actual costs from Azure Cost Management...');
    const { startDate, endDate } = getMonthToDatePeriod();
    const actualCosts = await fetchActualCosts(accessToken, subscriptionId, startDate, endDate);

    console.log('   🔍 Fetching detailed properties (this may take a moment)...');

    const resources: AzureResource[] = [];

    // Process in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < azureResources.length; i += batchSize) {
      const batch = azureResources.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async (azResource: any) => {
          try {
            const resourceGroup = azResource.id?.split('/resourceGroups/')[1]?.split('/')[0] || 'unknown';

            // Fetch detailed properties (provider-specific api-version for full template / sku)
            const details = await fetchResourceDetails(azResource.id, accessToken, azResource.type);

            // Get actual cost from Cost Management API
            const resourceIdLower = (azResource.id || '').toLowerCase();
            const actualCost = actualCosts.get(resourceIdLower) || 0;

            const resource: AzureResource = {
              id: azResource.id || '',
              name: azResource.name || '',
              type: azResource.type || '',
              location: azResource.location || '',
              resourceGroup,
              sku: details?.sku?.name || azResource.sku?.name || '',
              tier: details?.sku?.tier || azResource.sku?.tier || '',
              properties: details?.properties || azResource.properties || {},
              actualCostMTD: actualCost
            };

            resources.push(resource);
            const skuInfo = resource.sku ? ` (SKU: ${resource.sku})` : '';
            console.log(`      • ${resource.type}: ${resource.name}${skuInfo}`);
          } catch (parseError: any) {
            console.warn(`   ⚠️  Failed to parse resource:`, parseError.message);
          }
        })
      );

      // Small delay between batches
      if (i + batchSize < azureResources.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`\n✅ Successfully fetched ${resources.length} Azure resource(s)`);
    return resources;

  } catch (error: any) {
    console.error('❌ Failed to fetch Azure resources:', error);
    throw new Error(`Azure resource fetch failed: ${error.message}`);
  }
}

/**
 * Validates Azure connection by testing MCP client
 * Returns true if connection is successful
 */
export async function validateAzureConnection(userId?: string): Promise<boolean> {
  try {
    // Load Azure credentials from Bitwarden or env
    const hasCredentials = await loadAzureCredentials(userId);
    if (!hasCredentials) {
      console.error('❌ Azure credentials not found');
      return false;
    }

    console.log('\n🔐 Validating Azure connection...');

    // Get Azure resources MCP client (not devops)
    const client = await mcpClient.getClient('azure', 'resources');

    // Test connection by listing resource groups
    await client.callTool({
      name: 'azure_list_resource_groups',
      arguments: {}
    });

    console.log('✅ Azure connection validated successfully');
    return true;

  } catch (error: any) {
    console.error('❌ Azure connection validation failed:', error.message);
    return false;
  }
}
