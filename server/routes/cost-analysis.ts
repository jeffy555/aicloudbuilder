import type { Express } from "express";
import { storage } from "../storage";
import { mcpClient, type MCPProvider } from "../mcp-client";
import { openaiService } from "../openai-service";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { validateRequest } from "../middleware/validate";
import { sessionIdParams } from "@shared/api-contracts/common";
import { analyzeCostBody } from "@shared/api-contracts/cost-analysis";
import { getCachedPricing, setCachedPricing } from "../utils/pricing-cache";
import {
  HOURS_PER_MONTH,
  resolveAzureLocation,
  getPricingConfig,
  isFreeResource,
  getServiceName,
  buildPricingApiFilter,
  selectBestPricingItem,
  calculateMonthlyCost,
} from "../azure-pricing-config";
import { getAwsPricingConfig, isFreeAwsResource, calculateAwsMonthlyCost } from "../aws-pricing-config.js";
import { getGcpPricingConfig, isFreeGcpResource, calculateGcpMonthlyCost } from "../gcp-pricing-config.js";
import { hasUsageDimensions, getUsageDefaults, getUsageCatalog, applyUsageToAttrs } from "../azure-usage-catalog";
import {
  ENV_MULTIPLIERS,
  CONFIDENCE_THRESHOLDS,
} from "../config/constants.js";
import { COMPUTE_RESOURCE_TYPES_WITH_RESERVATIONS } from "../config/azure-catalog.js";
import {
  buildVariableMap,
  resolveResourceAttributes,
  resolveLocation,
  resolveResourceCount,
  type TerraformFile,
} from "../terraform-variable-resolver";
import type { CostStatus, UsageProfile, CostResource, CostAnalysisResult } from "../../shared/schema";

// Helper function to repair JSON (same as in openai-service.ts)
function repairJson(jsonText: string): string {
  let repaired = jsonText.trim();
  repaired = repaired.replace(/,(\s*[}\]])/g, '$1');
  repaired = repaired.replace(/,(\s*\n\s*[}\]])/g, '$1');
  repaired = repaired.replace(/\/\/.*$/gm, '');
  repaired = repaired.replace(/\/\*[\s\S]*?\*\//g, '');
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, (match, prefix, key) => {
    if (!match.includes('"')) {
      return `${prefix}"${key}":`;
    }
    return match;
  });
  return repaired;
}

export function registerCostAnalysisRoutes(app: Express): void {
  // Analyze cost for Terraform resources
  app.post("/api/sessions/:id/analyze-cost", optionalAuth, validateRequest({ params: sessionIdParams, body: analyzeCostBody }), async (req: AuthenticatedRequest, res) => {
    const sessionId = req.params.id;

    console.log(`\n💰 ========== COST ANALYSIS REQUEST ==========`);
    console.log(`Session ID: ${sessionId}`);
    console.log(`Timestamp: ${new Date().toISOString()}`);

    try {
      // Verify session exists
      const session = await storage.getSession(sessionId);
      if (!session) {
        return res.status(404).json({
          error: 'Session not found',
          details: `Session ${sessionId} does not exist`
        });
      }
      if (!session.userId || session.userId !== req.userId) {
        console.warn(`[SECURITY] Cost analysis session access denied: sessionId=${sessionId} sessionOwner=${session.userId} requesterId=${req.userId ?? 'anonymous'} ip=${req.ip}`);
        return res.status(403).json({ error: 'Access denied to this session' });
      }

      // CRITICAL: Fetch files from SESSION STORAGE (not repository)
      // This ensures we analyze the LATEST generated code, not the old repository code
      console.log(`\n🔍 Fetching files from SESSION STORAGE (latest generated code) for cost analysis...`);
      console.log(`   This includes all newly generated/updated resources`);

      const sessionFiles = await storage.getFilesBySession(sessionId);
      console.log(`✅ Found ${sessionFiles.length} file(s) in session storage`);

      let allFiles: Array<{ fileName: string; content: string; sessionId: string; id: string }>;

      if (sessionFiles.length === 0) {
        console.error(`❌ No files found in session storage`);
        // Fallback: Try repository if session storage is empty
        if (session.provider && session.repositoryName) {
          console.log(`   ⚠️  Falling back to repository...`);
          const repoFiles = await mcpClient.scanRepositoryFiles(
            session.provider as MCPProvider,
            session.repositoryName,
            'main'
          );
          allFiles = repoFiles
            .filter(file => file.path.endsWith('.tf') || file.path.endsWith('.tfvars'))
            .map(file => ({
              fileName: file.path.split('/').pop() || file.path,
              content: file.content,
              sessionId: sessionId,
              id: `temp-${file.path}`,
            }));

          if (allFiles.length === 0) {
            return res.status(400).json({
              error: 'No Terraform files found',
              details: 'No files in session storage or repository'
            });
          }

          console.log(`   ✅ Using ${allFiles.length} file(s) from repository (fallback)`);
        } else {
          return res.status(400).json({
            error: 'No files found',
            details: 'No files in session storage and no repository configured'
          });
        }
      } else {
        // Filter to Terraform files only from session storage
        allFiles = sessionFiles
          .filter(file => {
            const fileName = file.fileName.toLowerCase();
            return fileName.endsWith('.tf') || fileName.endsWith('.tfvars');
          })
          .map(file => ({
            fileName: file.fileName,
            content: file.content,
            sessionId: sessionId,
            id: file.id,
          }));

        console.log(`   ✅ Using ${allFiles.length} file(s) from session storage (latest generated code)`);
      }

      console.log(`📄 Terraform files found: ${allFiles.length}`);

      // Debug: Show all files
      if (allFiles.length > 0) {
        console.log(`📄 Files to analyze:`);
        allFiles.forEach((file, i) => {
          console.log(`   ${i + 1}. ${file.fileName} (content length: ${file.content?.length || 0} bytes)`);
          if (file.content && file.content.length > 0) {
            const preview = file.content.substring(0, 150).replace(/\n/g, ' ');
            console.log(`      Preview: ${preview}...`);
          }
        });
      } else {
        console.warn(`⚠️  No Terraform files found in session storage or repository`);
        if (session.repositoryName) {
          console.warn(`   Repository: ${session.repositoryName}`);
        }
        if (session.provider) {
          console.warn(`   Provider: ${session.provider}`);
        }
      }

      const terraformFiles = allFiles.filter(file => {
        const fileName = file.fileName.toLowerCase();
        const isTerraform = fileName.endsWith('.tf') || fileName.endsWith('.tfvars') || fileName.endsWith('.hcl');

        if (isTerraform && (!file.content || file.content.trim().length === 0)) {
          console.warn(`   ⚠️  Skipping empty Terraform file: ${file.fileName}`);
          return false;
        }

        // For aggregated-root, exclude backend files (they don't have cost)
        if (session.moduleApproach === 'aggregated-root' && isTerraform) {
          const backendFiles = ['backend.tf', 'provider.tf', 'terraform.tf'];
          if (backendFiles.includes(fileName)) {
            console.log(`   ⏭️  Skipping backend file for cost analysis: ${file.fileName}`);
            return false;
          }
        }

        return isTerraform;
      });

      console.log(`📋 Terraform files for cost analysis: ${terraformFiles.length}`);
      terraformFiles.forEach(f => {
        console.log(`   - ${f.fileName} (${f.content.length} bytes)`);
      });

      console.log(`📁 Found ${terraformFiles.length} Terraform file(s) with content`);

      // Parse request body for profile and custom usage
      const requestProfile: UsageProfile = (req.body?.profile as UsageProfile) || 'medium';
      const customUsage: Record<string, Record<string, number>> = req.body?.customUsage || {};
      console.log(`📊 Usage profile: ${requestProfile}`);
      if (Object.keys(customUsage).length > 0) {
        console.log(`   Custom usage overrides: ${JSON.stringify(customUsage)}`);
      }

      // Multi-environment cost profile — multipliers defined in config/constants.ts
      const usageProfile = (req.body?.usageProfile as string) in ENV_MULTIPLIERS
        ? (req.body?.usageProfile as string)
        : 'prod';
      const envMultiplier = ENV_MULTIPLIERS[usageProfile];
      console.log(`🌍 Environment profile: ${usageProfile} (${envMultiplier}× usage-based costs)`);

      // Build variable resolution map from all terraform files
      const tfFiles: TerraformFile[] = terraformFiles.map(f => ({
        fileName: f.fileName,
        content: f.content,
      }));
      const variableMap = buildVariableMap(tfFiles);
      const resolvedVarCount = Object.keys(variableMap).filter(k => !k.startsWith('__')).length;
      console.log(`🔧 Variable map built: ${resolvedVarCount} variable(s) resolved from tfvars/variables.tf`);

      if (terraformFiles.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No Terraform files found',
          details: 'No Terraform files exist for this session or all files are empty. Please generate Terraform files first.',
          summary: {
            totalMonthly: 0,
            totalYearly: 0,
            currency: 'USD',
            resourceCount: 0
          },
          resources: []
        });
      }

      // Step 1: Use AI to analyze Terraform files and extract resource information
      console.log(`\n🤖 Step 1: Analyzing Terraform files...`);

      // Get cloud provider from session (with ArchMe fallback)
      let cloudProvider = session.cloudProvider || 'azure';
      if (!session.cloudProvider && session.archMeAnalysis) {
        try {
          const archAnalysis = JSON.parse(session.archMeAnalysis as string);
          if (archAnalysis.cloudProvider && archAnalysis.cloudProvider !== 'multi' && archAnalysis.cloudProvider !== 'hybrid') {
            cloudProvider = archAnalysis.cloudProvider;
          } else if (archAnalysis.detectedProviders?.length === 1) {
            cloudProvider = archAnalysis.detectedProviders[0];
          }
        } catch { /* ignore parse errors */ }
      }
      console.log(`   📋 Cloud provider: ${cloudProvider}${!session.cloudProvider && session.archMeAnalysis ? ' (from ArchMe analysis)' : ''}`);

      const filesContent = terraformFiles.map(f => ({
        path: f.fileName,
        content: f.content
      }));

      // First, try direct parsing as fallback
      console.log(`   📋 Attempting direct Terraform parsing...`);
      const directParsedResources: any[] = [];

      for (const file of terraformFiles) {
        const content = file.content;
        console.log(`   📄 Parsing file: ${file.fileName} (${content.length} bytes)`);

        // Parse resource blocks directly (handles multi-line blocks with nested structures)
        // Match: resource "type" "name" { ... } - need to handle nested braces
        const resourceMatches: Array<{ type: string; name: string; body: string; start: number }> = [];

        // Find all resource declarations
        const resourceDeclRegex = /resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/g;
        let declMatch;

        while ((declMatch = resourceDeclRegex.exec(content)) !== null) {
          const resourceType = declMatch[1];
          const resourceName = declMatch[2];
          const startPos = declMatch.index;
          const openBracePos = declMatch.index + declMatch[0].length - 1;

          // Process resources based on cloud provider
          const isAzureResource = resourceType.startsWith('azurerm_') || resourceType.startsWith('azapi_');
          const isAWSResource = resourceType.startsWith('aws_');
          const isGCPResource = resourceType.startsWith('google_');

          if ((cloudProvider === 'azure' && isAzureResource) || (cloudProvider === 'aws' && isAWSResource) || (cloudProvider === 'gcp' && isGCPResource)) {
            // Find matching closing brace (handle nested braces)
            let braceCount = 1;
            let pos = openBracePos + 1;
            let inString = false;
            let stringChar = '';

            while (pos < content.length && braceCount > 0) {
              const char = content[pos];

              if (!inString) {
                if (char === '"' || char === "'") {
                  inString = true;
                  stringChar = char;
                } else if (char === '{') {
                  braceCount++;
                } else if (char === '}') {
                  braceCount--;
                }
              } else {
                if (char === stringChar && content[pos - 1] !== '\\') {
                  inString = false;
                }
              }

              pos++;
            }

            if (braceCount === 0) {
              const resourceBody = content.substring(openBracePos + 1, pos - 1);
              resourceMatches.push({
                type: resourceType,
                name: resourceName,
                body: resourceBody,
                start: startPos
              });
            }
          }
        }

          // Process each found resource
          for (const match of resourceMatches) {
            // Check if this resource uses count or for_each
            const hasCount = /count\s*=/.test(match.body);
            const hasForEach = /for_each\s*=/.test(match.body);

            if (hasCount || hasForEach) {
              console.log(`   ✅ Found resource: ${match.type}.${match.name} (with ${hasCount ? 'count' : 'for_each'})`);
            } else {
              console.log(`   ✅ Found resource: ${match.type}.${match.name}`);
            }

          // Extract location/region (handles both quoted and unquoted, with/without spaces)
          // AWS uses "region", Azure uses "location"
          // Also handles references like azurerm_resource_group.test.name or aws_region.current.name
          const locationField = cloudProvider === 'aws' ? 'region' : 'location';
          const defaultLocation = cloudProvider === 'aws' ? 'us-east-1' : 'eastus';

          // Try the cloud provider-specific field first
          let locationMatch = match.body.match(new RegExp(`${locationField}\\s*=\\s*"?([^"\\s\\n}]+)"?`));
          // Fallback to the other field if not found
          if (!locationMatch) {
            const fallbackField = cloudProvider === 'aws' ? 'location' : 'region';
            locationMatch = match.body.match(new RegExp(`${fallbackField}\\s*=\\s*"?([^"\\s\\n}]+)"?`));
          }

          let location = defaultLocation;
          if (locationMatch) {
            const rawLocation = locationMatch[1].trim().replace(/^["']|["']$/g, '');
            const locResult = resolveLocation(rawLocation, variableMap, defaultLocation);
            location = locResult.location;
          }

          // Extract attributes
          const attributes: Record<string, any> = {
            resource_type: match.type,
            resource_name: match.name
          };

          // Handle count and for_each for ALL cloud providers (before other attributes)
          // Extract count (numeric value or variable reference)
          const countMatch = match.body.match(/count\s*=\s*([^\s\n}]+)/);
          if (countMatch) {
            const countValue = countMatch[1].trim().replace(/^["']|["']$/g, '');
            // Try to parse as number, otherwise it's a variable reference
            const countNum = parseInt(countValue, 10);
            if (!isNaN(countNum)) {
              attributes.count = countNum;
              attributes.resource_count = countNum; // Actual count for cost calculation
            } else {
              attributes.count = countValue; // Variable reference
              attributes.resource_count = 1; // Default to 1, will need to resolve from tfvars
            }
          }

          // Extract for_each (set or map)
          const forEachMatch = match.body.match(/for_each\s*=\s*([^\s\n}]+)/);
          if (forEachMatch) {
            const forEachValue = forEachMatch[1].trim();
            // Try to extract count from for_each
            // Pattern: toset(["a", "b", "c"]) or var.some_set
            const setMatch = forEachValue.match(/toset\(\[([^\]]+)\]\)/);
            if (setMatch) {
              const items = setMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
              attributes.for_each_count = items.length;
              attributes.resource_count = items.length;
            } else if (forEachValue.startsWith('var.')) {
              // Variable reference - will need to resolve from tfvars
              attributes.for_each = forEachValue;
              attributes.resource_count = 1; // Default, will need to resolve
            } else {
              // Could be a map or other expression
              attributes.for_each = forEachValue;
              attributes.resource_count = 1; // Default
            }
          }

          // Determine actual resource count (for cost calculation)
          let actualResourceCount = attributes.resource_count || 1; // Default to 1 if no count/for_each

          // Azure-specific attributes
          if (cloudProvider === 'azure') {
            // Helper to extract a simple attribute value, resolving var. references via variableMap
            const extractAttr = (key: string): string | undefined => {
              const m = match.body.match(new RegExp(`${key}\\s*=\\s*"?([^"\\s\\n}]+)"?`));
              if (!m) return undefined;
              let value = m[1].trim().replace(/^["']|["']$/g, '');
              // Resolve var. references using the pre-built variable map
              if (value.startsWith('var.')) {
                const varName = value.replace('var.', '');
                if (varName in variableMap) {
                  value = variableMap[varName];
                } else {
                  return undefined; // Unresolved -> use defaults
                }
              }
              return value;
            };

            // Storage account attributes
            const tierVal = extractAttr('account_tier');
            if (tierVal) attributes.account_tier = tierVal;
            const replVal = extractAttr('account_replication_type');
            if (replVal) attributes.account_replication_type = replVal;
            const kindVal = extractAttr('account_kind');
            if (kindVal) attributes.account_kind = kindVal;
            const accessTierVal = extractAttr('access_tier');
            if (accessTierVal) attributes.access_tier = accessTierVal;

            // Handle nested sku blocks
            const skuBlockMatch = match.body.match(/sku\s*\{([^}]+)\}/);
            if (skuBlockMatch) {
              const skuBody = skuBlockMatch[1];
              const skuTierMatch = skuBody.match(/tier\s*=\s*"?([^"\s\n}]+)"?/);
              const skuSizeMatch = skuBody.match(/size\s*=\s*"?([^"\s\n}]+)"?/);
              if (skuTierMatch) attributes.sku = skuTierMatch[1].trim().replace(/^["']|["']$/g, '');
              if (skuSizeMatch) attributes.sku_size = skuSizeMatch[1].trim().replace(/^["']|["']$/g, '');
              if (skuTierMatch && skuSizeMatch) {
                attributes.sku_name = `${attributes.sku}${attributes.sku_size}`;
              }
            } else {
              const skuMatch = extractAttr('sku');
              if (skuMatch) attributes.sku = skuMatch;
            }

            // sku_name (standalone, overrides nested if present)
            const skuNameVal = extractAttr('sku_name');
            if (skuNameVal) attributes.sku_name = skuNameVal;

            // sku_tier (for Firewall, etc.)
            const skuTierVal = extractAttr('sku_tier');
            if (skuTierVal) attributes.sku_tier = skuTierVal;

            // VM size (for azurerm_virtual_machine, linux_virtual_machine, windows_virtual_machine)
            const vmSizeVal = extractAttr('vm_size');
            if (vmSizeVal) attributes.vm_size = vmSizeVal;
            const sizeVal = extractAttr('size');
            if (sizeVal) attributes.size = sizeVal;

            // App Service plan reference
            const planIdVal = extractAttr('app_service_plan_id');
            if (planIdVal) attributes.app_service_plan_id = planIdVal;
            const servicePlanIdVal = extractAttr('service_plan_id');
            if (servicePlanIdVal) attributes.service_plan_id = servicePlanIdVal;

            // Managed disk attributes
            const storageAcctTypeVal = extractAttr('storage_account_type');
            if (storageAcctTypeVal) attributes.storage_account_type = storageAcctTypeVal;
            const diskSizeVal = extractAttr('disk_size_gb');
            if (diskSizeVal) attributes.disk_size_gb = diskSizeVal;
            const sizeGbVal = extractAttr('size_gb');
            if (sizeGbVal) attributes.size_gb = sizeGbVal;

            // Public IP attributes
            const allocMethodVal = extractAttr('allocation_method');
            if (allocMethodVal) attributes.allocation_method = allocMethodVal;

            // Redis Cache attributes
            const capacityVal = extractAttr('capacity');
            if (capacityVal) attributes.capacity = capacityVal;
            const familyVal = extractAttr('family');
            if (familyVal) attributes.family = familyVal;

            // Cognitive Services / Search
            const cogKindVal = extractAttr('kind');
            if (cogKindVal) attributes.kind = cogKindVal;

            // Application Insights
            const dailyCapVal = extractAttr('daily_data_cap_in_gb');
            if (dailyCapVal) attributes.daily_data_cap_in_gb = dailyCapVal;

            // AKS default_node_pool attributes (nested block)
            const nodePoolBlock = match.body.match(/default_node_pool\s*\{([^}]+)\}/);
            if (nodePoolBlock) {
              const npBody = nodePoolBlock[1];
              const npVmSize = npBody.match(/vm_size\s*=\s*"?([^"\s\n}]+)"?/);
              if (npVmSize) attributes.default_node_pool_vm_size = npVmSize[1].trim().replace(/^["']|["']$/g, '');
              const npNodeCount = npBody.match(/node_count\s*=\s*"?([^"\s\n}]+)"?/);
              if (npNodeCount) attributes.default_node_pool_node_count = npNodeCount[1].trim().replace(/^["']|["']$/g, '');
              const npMinCount = npBody.match(/min_count\s*=\s*"?([^"\s\n}]+)"?/);
              if (npMinCount) attributes.node_count = npMinCount[1].trim().replace(/^["']|["']$/g, '');
            }

            // Container Group attributes (cpu, memory)
            const cpuVal = extractAttr('cpu');
            if (cpuVal) attributes.cpu = cpuVal;
            const memVal = extractAttr('memory');
            if (memVal) attributes.memory = memVal;

            // Container / resources block for container_group
            const containerBlock = match.body.match(/container\s*\{([\s\S]*?)\}/);
            if (containerBlock) {
              const cBody = containerBlock[1];
              const cCpu = cBody.match(/cpu\s*=\s*"?([^"\s\n}]+)"?/);
              if (cCpu && !attributes.cpu) attributes.cpu = cCpu[1].trim().replace(/^["']|["']$/g, '');
              const cMem = cBody.match(/memory\s*=\s*"?([^"\s\n}]+)"?/);
              if (cMem && !attributes.memory) attributes.memory = cMem[1].trim().replace(/^["']|["']$/g, '');
            }
          }

          // AWS-specific attributes
          if (cloudProvider === 'aws') {
            // EC2 attributes
            const instanceTypeMatch = match.body.match(/instance_type\s*=\s*"?([^"\s\n}]+)"?/);
            if (instanceTypeMatch) attributes.instance_type = instanceTypeMatch[1].trim().replace(/^["']|["']$/g, '');

            // Lambda attributes
            const memorySizeMatch = match.body.match(/memory_size\s*=\s*"?([^"\s\n}]+)"?/);
            if (memorySizeMatch) attributes.memory_size = memorySizeMatch[1].trim().replace(/^["']|["']$/g, '');

            const timeoutMatch = match.body.match(/timeout\s*=\s*"?([^"\s\n}]+)"?/);
            if (timeoutMatch) attributes.timeout = timeoutMatch[1].trim().replace(/^["']|["']$/g, '');

            // RDS attributes
            const instanceClassMatch = match.body.match(/instance_class\s*=\s*"?([^"\s\n}]+)"?/);
            if (instanceClassMatch) attributes.instance_class = instanceClassMatch[1].trim().replace(/^["']|["']$/g, '');

            const engineMatch = match.body.match(/engine\s*=\s*"?([^"\s\n}]+)"?/);
            if (engineMatch) attributes.engine = engineMatch[1].trim().replace(/^["']|["']$/g, '');

            const multiAzMatch = match.body.match(/multi_az\s*=\s*"?([^"\s\n}]+)"?/);
            if (multiAzMatch) {
              const multiAzValue = multiAzMatch[1].trim().replace(/^["']|["']$/g, '');
              attributes.multi_az = multiAzValue === 'true';
            }

            // DynamoDB attributes
            const billingModeMatch = match.body.match(/billing_mode\s*=\s*"?([^"\s\n}]+)"?/);
            if (billingModeMatch) attributes.billing_mode = billingModeMatch[1].trim().replace(/^["']|["']$/g, '');

            const readCapacityMatch = match.body.match(/read_capacity\s*=\s*"?([^"\s\n}]+)"?/);
            if (readCapacityMatch) attributes.read_capacity = readCapacityMatch[1].trim().replace(/^["']|["']$/g, '');

            const writeCapacityMatch = match.body.match(/write_capacity\s*=\s*"?([^"\s\n}]+)"?/);
            if (writeCapacityMatch) attributes.write_capacity = writeCapacityMatch[1].trim().replace(/^["']|["']$/g, '');

            // ElastiCache attributes
            const nodeTypeMatch = match.body.match(/node_type\s*=\s*"?([^"\s\n}]+)"?/);
            if (nodeTypeMatch) attributes.node_type = nodeTypeMatch[1].trim().replace(/^["']|["']$/g, '');

            const numCacheNodesMatch = match.body.match(/num_cache_nodes\s*=\s*"?([^"\s\n}]+)"?/);
            if (numCacheNodesMatch) attributes.num_cache_nodes = numCacheNodesMatch[1].trim().replace(/^["']|["']$/g, '');
          }

          // Resolve count/for_each using the variable resolver
          const countResult = resolveResourceCount(match.body, variableMap);
          actualResourceCount = countResult.count;
          if (countResult.count > 1) {
            attributes.resource_count = countResult.count;
            console.log(`   ✅ Resolved resource count = ${countResult.count} (${countResult.resolved ? 'resolved' : 'default'})`);
          }

          // Create resource entries - if count > 1, create multiple entries for accurate cost calculation
          for (let i = 0; i < actualResourceCount; i++) {
            const resourceName = actualResourceCount > 1 ? `${match.name}[${i}]` : match.name;

            // Store location/region in the appropriate field based on cloud provider
            const resourceData: any = {
              resourceType: match.type,
              resourceName: resourceName,
              attributes: {
                ...attributes,
                instance_index: actualResourceCount > 1 ? i : undefined
              }
            };

            if (cloudProvider === 'aws') {
              resourceData.region = location;
            } else {
              resourceData.location = location;
            }

            directParsedResources.push(resourceData);
          }

          if (actualResourceCount > 1) {
            console.log(`   📊 Resource count: ${actualResourceCount} (expanded from count/for_each)`);
          }
        }
      }

      console.log(`   📊 Direct parsing found ${directParsedResources.length} resource(s)`);

      // Now try AI analysis
      console.log(`   🤖 Attempting AI analysis...`);

      // Build cloud provider-specific prompt
      const isAWS = cloudProvider === 'aws';
      const resourcePrefix = isAWS ? 'aws_' : 'azurerm_';
      const resourceExamples = isAWS
        ? 'aws_s3_bucket, aws_ec2_instance, aws_lambda_function, aws_rds_instance, aws_dynamodb_table, aws_apigateway_rest_api, etc.'
        : 'azurerm_storage_account, azurerm_function_app, azurerm_logic_app_workflow, azurerm_frontdoor, azurerm_app_service, azurerm_app_service_plan, azurerm_static_site, azurerm_resource_group, etc.';
      const locationField = isAWS ? 'region' : 'location';
      const defaultLocation = isAWS ? 'us-east-1' : 'eastus';
      const pricingAttributes = isAWS
        ? `   - For EC2: instance_type, instance_count
   - For S3: versioning, lifecycle_rules, storage_class
   - For RDS: instance_class, engine, multi_az
   - For Lambda: memory_size, timeout
   - For DynamoDB: billing_mode, read_capacity, write_capacity
   - For API Gateway: api_type, endpoint_type
   - Any size, tier, or capacity information`
        : `   - For Storage: account_tier, account_replication_type, account_kind
   - For Function App: app_service_plan_id, consumption plan vs dedicated
   - For Logic App: sku, location
   - For Front Door: sku_name, location
   - For App Service: app_service_plan_id, sku
   - For App Service Plan: sku, sku_name, kind
   - For Static Web App: sku_size, location
   - Any size, tier, or SKU information`;

      const analysisPrompt = `Analyze these Terraform files and identify ALL ${isAWS ? 'AWS' : 'Azure'} resources with their pricing-relevant attributes.

CRITICAL: You MUST find and extract ALL resources that start with "${resourcePrefix}"${isAWS ? '' : ' or "azapi_"'}. Do not skip any resources.

For each resource, extract:
1. Resource type (e.g., ${resourceExamples})
2. Resource name (the label after the resource type, e.g., "mybucket" in "resource ${resourcePrefix}${isAWS ? 's3_bucket' : 'storage_account'} mybucket")
3. ${isAWS ? 'Region' : 'Location/region'} (from ${locationField} attribute${isAWS ? '' : ' or resource group location'})
4. Pricing-relevant attributes:
${pricingAttributes}

IMPORTANT:
- Include ALL resources, even if they don't have explicit pricing
- Extract ${locationField} from the resource's "${locationField}" attribute${isAWS ? '' : ', or infer from resource group'}
- If ${locationField} is not specified, use "${defaultLocation}" as default
- Extract ALL attributes that might affect pricing

Return ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "resources": [
    {
      "resourceType": "${resourcePrefix}${isAWS ? 's3_bucket' : 'storage_account'}",
      "resourceName": "${isAWS ? 'mybucket' : 'mystorage'}",
      "${locationField}": "${defaultLocation}",
      "attributes": {
        ${isAWS ? '"versioning": "Enabled",\n        "lifecycle_rules": []' : '"account_tier": "Standard",\n        "account_replication_type": "LRS",\n        "account_kind": "StorageV2"'}
      }
    }
  ]
}

Terraform files:
${JSON.stringify(filesContent, null, 2)}

Remember: Return ONLY the JSON object, no other text.`;

      let aiParsedResources: any[] = [];
      try {
        const aiAnalysis = await openaiService.chat([
          {
            role: 'system',
            content: `You are an expert at analyzing Terraform files and extracting ${isAWS ? 'AWS' : 'Azure'} resource information for cost estimation. Return only valid JSON.`
          },
          {
            role: 'user',
            content: analysisPrompt
          }
        ]);

        console.log(`\n📝 AI Response (first 500 chars): ${aiAnalysis.substring(0, 500)}...`);

        const cleanedResponse = aiAnalysis.trim();
        const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
        let parsedData: any;

        if (jsonMatch) {
          parsedData = JSON.parse(jsonMatch[0]);
        } else {
          parsedData = JSON.parse(cleanedResponse);
        }

        aiParsedResources = parsedData.resources || parsedData || [];

        console.log(`\n✅ Parsed ${aiParsedResources.length} resource(s) from AI analysis`);
        if (aiParsedResources.length > 0) {
          aiParsedResources.forEach((r: any, idx: number) => {
            console.log(`   ${idx + 1}. ${r.resourceType} - ${r.resourceName} (${r.location || 'no location'})`);
          });
        } else {
          console.warn(`   ⚠️  No resources found in AI response!`);
          console.warn(`   Full AI response: ${aiAnalysis}`);
        }
      } catch (aiError: any) {
        console.warn(`⚠️  AI analysis failed (non-fatal): ${aiError.message}`);
        console.warn('   Will use direct parsing results instead');
      }

      // Combine direct parsing and AI results, prefer direct parsing if it found resources
      // (more reliable than AI which might fail or return empty)
      let parsedResources: any[] = [];

      console.log(`\n📊 Parsing Summary:`);
      console.log(`   Direct parsing: ${directParsedResources.length} resource(s)`);
      console.log(`   AI parsing: ${aiParsedResources.length} resource(s)`);

      if (directParsedResources.length > 0) {
        console.log(`\n✅ Using direct parsing results (${directParsedResources.length} resources)`);
        parsedResources = directParsedResources;

        // If AI also found resources, merge them (AI might have more attributes)
        if (aiParsedResources.length > 0) {
          console.log(`   Merging with AI results for additional attributes...`);
          // Create a map of direct parsed resources by type+name
          const directMap = new Map<string, any>();
          directParsedResources.forEach(r => {
            const key = `${r.resourceType}.${r.resourceName}`;
            directMap.set(key, r);
          });

          // Merge AI attributes into direct parsed resources (DO NOT add AI-only resources)
          aiParsedResources.forEach(aiRes => {
            const key = `${aiRes.resourceType}.${aiRes.resourceName}`;
            const directRes = directMap.get(key);
            if (directRes) {
              // Merge attributes from AI into directly-parsed resource
              directRes.attributes = { ...directRes.attributes, ...aiRes.attributes };
            } else {
              // AI hallucinated a resource not in the Terraform files - ignore it
              console.warn(`   ⚠️  Ignoring AI-only resource ${key} (not found by direct parsing)`);
            }
          });
        }
      } else if (aiParsedResources.length > 0) {
        console.log(`\n✅ Using AI analysis results (${aiParsedResources.length} resources)`);
        parsedResources = aiParsedResources;
      } else {
        console.error(`\n❌ No resources found by either method!`);
        console.error(`   Direct parsing: ${directParsedResources.length} resources`);
        console.error(`   AI parsing: ${aiParsedResources.length} resources`);
        console.error(`   Terraform files analyzed: ${terraformFiles.length}`);
        terraformFiles.forEach(f => {
          console.error(`     - ${f.fileName} (${f.content.length} bytes)`);
          // Show first 500 chars of content for debugging
          console.error(`       Content preview: ${f.content.substring(0, 500).replace(/\n/g, ' ')}...`);
        });

        return res.status(400).json({
          success: false,
          error: 'No resources found',
          details: `No ${cloudProvider === 'aws' ? 'AWS' : cloudProvider === 'gcp' ? 'GCP' : 'Azure'} resources were detected in the Terraform files. Make sure your files contain valid resource definitions (e.g., resource "${cloudProvider === 'aws' ? 'aws_s3_bucket' : cloudProvider === 'gcp' ? 'google_storage_bucket' : 'azurerm_storage_account'}" "name" { ... }).`,
          summary: {
            totalMonthly: 0,
            totalYearly: 0,
            currency: 'USD',
            resourceCount: 0
          },
          resources: []
        });
      }

      console.log(`\n📊 Final resource list (${parsedResources.length} resources):`);
      parsedResources.forEach((r, idx) => {
        const locationField = cloudProvider === 'aws' ? 'region' : 'location';
        const defaultLocation = cloudProvider === 'aws' ? 'us-east-1' : 'eastus';
        const resourceLocation = r[locationField] || r.location || r.region || defaultLocation;
        console.log(`   ${idx + 1}. ${r.resourceType}.${r.resourceName} (${resourceLocation})`);
        if (Object.keys(r.attributes || {}).length > 0) {
          console.log(`      Attributes: ${JSON.stringify(r.attributes)}`);
        }
      });

      // Step 2: Map Terraform resource types to Azure service names (deterministic lookup)
      console.log(`\n📋 Mapping resource types to service names (deterministic)...`);
      const uniqueResourceTypes = Array.from(new Set(parsedResources.map(r => r.resourceType)));
      const resourceTypeToService: Record<string, string> = {};

      for (const rt of uniqueResourceTypes) {
        resourceTypeToService[rt] = getServiceName(rt);
      }
      console.log(`   ✅ Mapped ${Object.keys(resourceTypeToService).length} resource type(s) to service names`);

      // Step 3: Query pricing for each resource
      const providerLabel = cloudProvider === 'aws' ? 'AWS' : cloudProvider === 'gcp' ? 'GCP' : 'Azure';
      console.log(`\n💰 Step 2: Querying ${providerLabel} Pricing...`);

      const costEstimates: CostResource[] = [];
      const skippedResources: Array<{
        resourceType: string;
        resourceName: string;
        reason: 'unsupported_type' | 'no_pricing_filter' | 'api_error' | 'no_items_found' | 'price_unavailable';
        suggestion?: string;
      }> = [];
      // Fix #3: Track prod-baseline totals for environment comparison
      let usageBasedProdTotal = 0;
      let computeProdTotal = 0;
      // Compute resource types that support Reserved Instance pricing
      // — sourced from config/azure-catalog.ts, not hardcoded here.
      const COMPUTE_RESOURCE_TYPES = COMPUTE_RESOURCE_TYPES_WITH_RESERVATIONS;

      console.log(`\n💰 Step 2: Querying ${providerLabel} Pricing API for ${parsedResources.length} resource(s)...`);

      // AWS pricing handling (static rate table — no live API call required)
      if (cloudProvider === 'aws') {
        console.log(`\n💰 AWS Pricing: Using static rate table (aws-pricing-config)...`);

        for (const resource of parsedResources) {
          const rawType = resource.resourceType;
          const serviceName = rawType.replace(/^aws_/, '').split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

          // Free resource check
          const freeReason = isFreeAwsResource(rawType);
          if (freeReason) {
            console.log(`      ⏭️  Free (AWS): ${freeReason}`);
            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: rawType,
              serviceName,
              monthlyCost: 0,
              yearlyCost: 0,
              currency: 'USD',
              status: 'exact',
              pricingMatchType: 'free',
              confidenceScore: 1.0,
              confidenceLabel: 'high',
              assumptionsUsed: [freeReason],
            });
            continue;
          }

          // Supported resource check
          const awsConfig = getAwsPricingConfig(rawType);
          if (!awsConfig) {
            console.warn(`      ⚠️  No AWS pricing config for ${rawType}`);
            skippedResources.push({
              resourceType: rawType,
              resourceName: resource.resourceName,
              reason: 'unsupported_type',
              suggestion: `${rawType} is not yet in the AWS pricing catalog.`,
            });
            continue;
          }

          // Calculate from static table
          const monthlyCost = calculateAwsMonthlyCost(rawType, null, resource.attributes || {}) ?? 0;
          const yearlyCost = monthlyCost * 12;

          console.log(`      ✅ ${rawType} (${resource.resourceName}): $${monthlyCost.toFixed(2)}/mo`);
          costEstimates.push({
            resourceName: resource.resourceName,
            resourceType: rawType,
            serviceName,
            monthlyCost,
            yearlyCost,
            currency: 'USD',
            status: 'estimated',
            pricingMatchType: 'fallback',
            confidenceScore: 0.7,
            confidenceLabel: 'medium',
            assumptionsUsed: [`Based on default ${awsConfig.defaults ? JSON.stringify(awsConfig.defaults) : 'settings'}`],
          });
        }

      // GCP pricing handling (static rate table — no live API call required)
      } else if (cloudProvider === 'gcp') {
        console.log(`\n💰 GCP Pricing: Using static rate table (gcp-pricing-config)...`);

        for (const resource of parsedResources) {
          const rawType = resource.resourceType;
          const serviceName = rawType.replace(/^google_/, '').split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

          // Free resource check
          const freeReason = isFreeGcpResource(rawType);
          if (freeReason) {
            console.log(`      ⏭️  Free (GCP): ${freeReason}`);
            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: rawType,
              serviceName,
              monthlyCost: 0,
              yearlyCost: 0,
              currency: 'USD',
              status: 'exact',
              pricingMatchType: 'free',
              confidenceScore: 1.0,
              confidenceLabel: 'high',
              assumptionsUsed: [freeReason],
            });
            continue;
          }

          // Supported resource check
          const gcpConfig = getGcpPricingConfig(rawType);
          if (!gcpConfig) {
            console.warn(`      ⚠️  No GCP pricing config for ${rawType}`);
            skippedResources.push({
              resourceType: rawType,
              resourceName: resource.resourceName,
              reason: 'unsupported_type',
              suggestion: `${rawType} is not yet in the GCP pricing catalog.`,
            });
            continue;
          }

          // Calculate from static table
          const monthlyCost = calculateGcpMonthlyCost(rawType, resource.attributes || {}) ?? 0;
          const yearlyCost = monthlyCost * 12;

          console.log(`      ✅ ${rawType} (${resource.resourceName}): $${monthlyCost.toFixed(2)}/mo`);
          costEstimates.push({
            resourceName: resource.resourceName,
            resourceType: rawType,
            serviceName,
            monthlyCost,
            yearlyCost,
            currency: 'USD',
            status: 'estimated',
            pricingMatchType: 'fallback',
            confidenceScore: 0.7,
            confidenceLabel: 'medium',
            assumptionsUsed: [`Based on default ${gcpConfig.defaults ? JSON.stringify(gcpConfig.defaults) : 'settings'}`],
          });
        }

      } else {
        // Azure pricing (deterministic lookup-based) with status classification
        for (const resource of parsedResources) {
          const serviceName = resourceTypeToService[resource.resourceType] || resource.resourceType;
          const resourceAddr = `${resource.resourceType}.${resource.resourceName}`;
          console.log(`\n   [${parsedResources.indexOf(resource) + 1}/${parsedResources.length}] Querying pricing for: ${serviceName} (${resource.resourceName})`);
          console.log(`      Type: ${resource.resourceType}`);
          console.log(`      Location: ${resource.location || 'eastus'}`);

          // Resolve attributes using the variable map, track unresolved
          const { attrs: resolvedAttrs, unresolved: unresolvedVars } = resolveResourceAttributes(
            resource.attributes || {},
            variableMap
          );
          if (unresolvedVars.length > 0) {
            console.log(`      ⚠️  Unresolved variables: ${unresolvedVars.join(', ')}`);
          }

          // Get usage dimensions and apply profile/custom overrides
          const usageCatalog = getUsageCatalog(resource.resourceType);
          const usageDefaults = getUsageDefaults(resource.resourceType, requestProfile);
          const resourceCustomUsage = customUsage[resourceAddr] || {};
          const appliedUsage = { ...usageDefaults, ...resourceCustomUsage };
          const isUsageBased = hasUsageDimensions(resource.resourceType);

          // Skip free Azure resources (no direct cost)
          const freeReason = isFreeResource(resource.resourceType);
          if (freeReason) {
            console.log(`      ⏭️  Free: ${freeReason}`);
            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: resource.resourceType,
              serviceName,
              monthlyCost: 0,
              yearlyCost: 0,
              currency: 'USD',
              status: 'exact',
              pricingMatchType: 'free',
              confidenceScore: 1.0,
              confidenceLabel: 'high',
              assumptionsUsed: [freeReason],
            });
            continue;
          }

          try {
            const pricingConfig = getPricingConfig(resource.resourceType);
            const azureLocation = resolveAzureLocation(resource.location || 'eastus');

            // Check for resources with no direct cost (cost is in parent resource)
            if (pricingConfig && pricingConfig.buildFilter(resolvedAttrs, azureLocation) === '') {
              console.log(`      ℹ️  ${resource.resourceType} has no direct cost (cost is in parent resource)`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'exact',
                pricingMatchType: 'parent',
                confidenceScore: 1.0,
                confidenceLabel: 'high',
                assumptionsUsed: ['Cost billed through parent resource'],
                details: resolvedAttrs,
              });
              continue;
            }

            // If critical SKU attributes are unresolved, mark as needs_input
            const criticalAttrs = pricingConfig?.attributeKeys || [];
            const hasCriticalUnresolved = criticalAttrs.some(key => {
              const val = resolvedAttrs[key];
              return typeof val === 'string' && val.startsWith('var.');
            });

            if (hasCriticalUnresolved && !pricingConfig?.defaults) {
              console.warn(`      ⚠️  Critical attributes unresolved for ${resource.resourceType}`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'needs_input',
                pricingMatchType: 'unsupported',
                confidenceScore: 0,
                confidenceLabel: 'low',
                assumptionsUsed: [],
                unresolvedVariables: unresolvedVars,
                usageDimensions: criticalAttrs.map(key => ({
                  key,
                  label: key,
                  unit: '',
                  defaultValue: 0,
                })),
              });
              continue;
            }

            // If no pricing config exists, mark as unsupported (no heuristic fallback)
            if (!pricingConfig) {
              console.warn(`      ⚠️  No pricing config for ${resource.resourceType} - marking as unsupported`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'needs_input',
                pricingMatchType: 'unsupported',
                confidenceScore: 0,
                confidenceLabel: 'low',
                assumptionsUsed: ['No deterministic pricing config available for this resource type'],
                unresolvedVariables: unresolvedVars.length > 0 ? unresolvedVars : undefined,
              });
              continue;
            }

            // Build the API filter
            let matchType: CostResource['pricingMatchType'] = 'config_exact';
            const filter = buildPricingApiFilter(resource.resourceType, resolvedAttrs, resource.location || 'eastus');

            if (!filter) {
              console.warn(`      ⚠️  No pricing filter available for ${resource.resourceType}`);
              skippedResources.push({
                resourceType: resource.resourceType,
                resourceName: resource.resourceName,
                reason: 'no_pricing_filter',
                suggestion: `No Azure Pricing API filter defined for ${resource.resourceType}. Check azure-pricing-config.ts to add support.`,
              });
              continue;
            }

            console.log(`      🔍 Filter: ${filter}`);

            // Check cache first — avoids re-hitting the Azure Pricing API for the same
            // filter within the 1-hour TTL (eliminates N sequential calls per /analyze-cost)
            let items: any[] = getCachedPricing(filter) ?? [];
            if (items.length > 0) {
              console.log(`      ✅ Cache hit — ${items.length} pricing item(s) (no API call)`);
            } else {
              const apiUrl = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}&$top=50`;
              const apiResponse = await fetch(apiUrl);
              if (!apiResponse.ok) {
                throw new Error(`Azure Pricing API returned ${apiResponse.status}: ${apiResponse.statusText}`);
              }
              const pricingData = await apiResponse.json();
              items = pricingData?.Items || [];
              console.log(`      📊 Found ${items.length} pricing item(s)`);
              setCachedPricing(filter, items);
            }

            // If no results, try a broader fallback filter (serviceName + region only)
            if (items.length === 0 && pricingConfig) {
              console.log(`      🔄 Trying broader filter...`);
              matchType = 'config_broad';
              const broadFilter = `serviceName eq '${pricingConfig.serviceName}' and armRegionName eq '${azureLocation}' and priceType eq 'Consumption'`;
              const cachedBroad = getCachedPricing(broadFilter);
              if (cachedBroad && cachedBroad.length > 0) {
                items = cachedBroad;
                console.log(`      ✅ Cache hit (broad) — ${items.length} item(s)`);
              } else {
                try {
                  const broadUrl = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(broadFilter)}&$top=50`;
                  const broadResponse = await fetch(broadUrl);
                  if (broadResponse.ok) {
                    const broadData = await broadResponse.json();
                    items = broadData?.Items || [];
                    if (items.length > 0) {
                      console.log(`      ✅ Found ${items.length} item(s) with broader filter`);
                      setCachedPricing(broadFilter, items);
                    }
                  }
                } catch (broadErr: any) {
                  console.warn(`      ⚠️  Broader query failed: ${broadErr.message}`);
                }
              }
            }

            if (items.length === 0) {
              console.warn(`      ❌ No pricing items found for ${serviceName} in ${azureLocation}`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'needs_input',
                pricingMatchType: 'unsupported',
                confidenceScore: 0,
                confidenceLabel: 'low',
                assumptionsUsed: ['No pricing data found in Azure Retail API'],
                usageDimensions: usageCatalog?.dimensions.map(d => ({
                  key: d.key,
                  label: d.label,
                  unit: d.unit,
                  defaultValue: d[requestProfile === 'custom' ? 'medium' : requestProfile],
                })),
              });
              continue;
            }

            // Select the best pricing item using the config's selector
            const priceItem = selectBestPricingItem(resource.resourceType, items, resolvedAttrs);

            if (!priceItem) {
              console.log(`      ℹ️  No applicable pricing item (resource may have no direct cost)`);
              costEstimates.push({
                resourceName: resource.resourceName,
                resourceType: resource.resourceType,
                serviceName,
                monthlyCost: 0,
                yearlyCost: 0,
                currency: 'USD',
                status: 'exact',
                pricingMatchType: matchType,
                confidenceScore: 0.8,
                confidenceLabel: 'medium',
                assumptionsUsed: ['No billable pricing item found - may be included in parent'],
                details: resolvedAttrs,
              });
              continue;
            }

            console.log(`      📊 Selected: ${priceItem.meterName} | ${priceItem.unitOfMeasure} | $${priceItem.retailPrice}`);

            // Merge usage-catalog values into attrs so calculateCost picks them up
            const costAttrs = isUsageBased
              ? applyUsageToAttrs(resource.resourceType, resolvedAttrs, appliedUsage)
              : resolvedAttrs;

            // Calculate monthly cost using the config's deterministic calculator
            const baseMonthlyCostRaw = calculateMonthlyCost(resource.resourceType, priceItem, costAttrs);

            // Fix #8: null means the pricing item exists but retailPrice is unavailable
            if (baseMonthlyCostRaw === null) {
              console.warn(`      ⚠️  retailPrice is null for ${resource.resourceName} — price unavailable`);
              skippedResources.push({
                resourceType: resource.resourceType,
                resourceName: resource.resourceName,
                reason: 'price_unavailable',
                suggestion: `Azure Pricing API returned a match for ${resource.resourceType} in ${azureLocation} but retailPrice was null. This resource may be in preview or not yet available in this region.`,
              });
              continue;
            }
            const baseMonthlyCost = baseMonthlyCostRaw;

            // Fix #3: Apply environment multiplier to usage-based resources only;
            // compute resources (VMs, App Service Plans) run 24/7 regardless of env.
            const monthlyCost = isUsageBased ? baseMonthlyCost * envMultiplier : baseMonthlyCost;
            if (isUsageBased) {
              usageBasedProdTotal += baseMonthlyCost;
            } else {
              computeProdTotal += baseMonthlyCost;
            }

            // Fix #4: Fetch Reserved Instance pricing for compute resources
            let reservedPricing: CostResource['reservedPricing'];
            if (COMPUTE_RESOURCE_TYPES.has(resource.resourceType) && pricingConfig) {
              const reservedBase = `serviceName eq '${pricingConfig.serviceName}' and armRegionName eq '${azureLocation}'`;
              try {
                const fetchReserved = async (term: string) => {
                  const f = `${reservedBase} and priceType eq 'Reservation' and reservationTerm eq '${term}'`;
                  let ri = getCachedPricing(f) ?? [];
                  if (ri.length === 0) {
                    const resp = await fetch(`https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(f)}&$top=20`);
                    if (resp.ok) { const d = await resp.json(); ri = d?.Items || []; if (ri.length > 0) setCachedPricing(f, ri); }
                  }
                  const item = selectBestPricingItem(resource.resourceType, ri, resolvedAttrs);
                  if (!item) return undefined;
                  const cost = calculateMonthlyCost(resource.resourceType, item, costAttrs);
                  if (cost === null) return undefined;
                  return { monthlyCost: Math.round(cost * 100) / 100, savingsPercent: baseMonthlyCost > 0 ? Math.round((1 - cost / baseMonthlyCost) * 100) : 0 };
                };
                const [oneYear, threeYear] = await Promise.all([fetchReserved('1 Year'), fetchReserved('3 Years')]);
                if (oneYear || threeYear) reservedPricing = { oneYear, threeYear };
                if (reservedPricing?.oneYear) {
                  console.log(`      💡 Reserved 1Y: $${reservedPricing.oneYear.monthlyCost}/mo (−${reservedPricing.oneYear.savingsPercent}%)`);
                }
              } catch (reservedErr: any) {
                console.warn(`      ⚠️  Reserved pricing fetch failed: ${reservedErr.message}`);
              }
            }

            const yearlyCost = monthlyCost * 12;

            console.log(`      ✅ Cost: $${monthlyCost.toFixed(2)}/month ($${yearlyCost.toFixed(2)}/year)`);

            // Determine status and confidence
            const assumptions: string[] = [];
            let status: CostStatus = 'exact';
            let confidenceScore = 1.0;

            if (isUsageBased) {
              status = Object.keys(resourceCustomUsage).length > 0 ? 'exact' : 'estimated';
              if (status === 'estimated') {
                assumptions.push(`Usage profile: ${requestProfile}`);
                for (const [dimKey, dimVal] of Object.entries(appliedUsage)) {
                  const dim = usageCatalog?.dimensions.find(d => d.key === dimKey);
                  assumptions.push(`${dim?.label || dimKey}: ${dimVal} ${dim?.unit || ''}`);
                }
                confidenceScore = CONFIDENCE_THRESHOLDS.MEDIUM;
              }
            }

            if (matchType === 'config_broad') {
              assumptions.push('Used broader SKU filter (exact SKU not found)');
              confidenceScore = Math.min(confidenceScore, CONFIDENCE_THRESHOLDS.MEDIUM);
              status = 'estimated';
            }
            if (unresolvedVars.length > 0) {
              assumptions.push(`Unresolved vars: ${unresolvedVars.join(', ')} - used defaults`);
              confidenceScore = Math.min(confidenceScore, CONFIDENCE_THRESHOLDS.PENALTY_BROAD_FILTER);
              status = 'estimated';
            }
            const confidenceLabel: CostResource['confidenceLabel'] =
              confidenceScore >= CONFIDENCE_THRESHOLDS.HIGH
                ? 'high'
                : confidenceScore >= CONFIDENCE_THRESHOLDS.MEDIUM
                ? 'medium'
                : 'low';

            costEstimates.push({
              resourceName: resource.resourceName,
              resourceType: resource.resourceType,
              serviceName,
              monthlyCost: Math.round(monthlyCost * 100) / 100,
              yearlyCost: Math.round(yearlyCost * 100) / 100,
              currency: 'USD',
              status,
              pricingMatchType: matchType,
              confidenceScore: Math.round(confidenceScore * 100) / 100,
              confidenceLabel,
              assumptionsUsed: assumptions,
              usageDimensions: usageCatalog?.dimensions.map(d => ({
                key: d.key,
                label: d.label,
                unit: d.unit,
                defaultValue: d[requestProfile === 'custom' ? 'medium' : requestProfile],
              })),
              providedUsage: Object.keys(appliedUsage).length > 0 ? appliedUsage : undefined,
              unresolvedVariables: unresolvedVars.length > 0 ? unresolvedVars : undefined,
              details: resolvedAttrs,
              reservedPricing, // Fix #4: undefined for non-compute resources
            });
          } catch (error: any) {
            console.error(`      ❌ Failed to get pricing for ${resource.resourceName}:`, error.message);
            skippedResources.push({
              resourceType: resource.resourceType,
              resourceName: resource.resourceName,
              reason: 'api_error',
              suggestion: error.message,
            });
          }
        } // End of Azure pricing loop
      } // End of cloud provider check

      // Calculate totals with status breakdown
      const exactResources = costEstimates.filter(r => r.status === 'exact');
      const estimatedResources = costEstimates.filter(r => r.status === 'estimated');
      const needsInputResources = costEstimates.filter(r => r.status === 'needs_input');
      const freeResources = costEstimates.filter(r => r.pricingMatchType === 'free' || r.pricingMatchType === 'parent');

      const monthlyTotalExact = exactResources.reduce((sum, r) => sum + r.monthlyCost, 0);
      const monthlyTotalEstimated = estimatedResources.reduce((sum, r) => sum + r.monthlyCost, 0);
      const monthlyGrandTotal = costEstimates.reduce((sum, r) => sum + r.monthlyCost, 0);
      const yearlyGrandTotal = monthlyGrandTotal * 12;

      console.log(`\n✅ Cost analysis completed`);
      console.log(`   Resources processed: ${costEstimates.length}`);
      console.log(`   Exact: ${exactResources.length} ($${monthlyTotalExact.toFixed(2)}/mo)`);
      console.log(`   Estimated: ${estimatedResources.length} ($${monthlyTotalEstimated.toFixed(2)}/mo)`);
      console.log(`   Needs Input: ${needsInputResources.length}`);
      console.log(`   Free: ${freeResources.length}`);
      console.log(`   Skipped: ${skippedResources.length}`);
      console.log(`   Grand Total: $${monthlyGrandTotal.toFixed(2)}/month`);

      // Fix #3: Compute multi-environment comparison from prod-baseline totals
      const envTotal = (multiplier: number) =>
        Math.round((computeProdTotal + usageBasedProdTotal * multiplier) * 100) / 100;
      const environmentComparison = {
        dev:  { monthlyTotal: envTotal(ENV_MULTIPLIERS.dev),  yearlyTotal: Math.round(envTotal(ENV_MULTIPLIERS.dev)  * 12 * 100) / 100, description: `dev (${ENV_MULTIPLIERS.dev * 100}% traffic)` },
        test: { monthlyTotal: envTotal(ENV_MULTIPLIERS.test), yearlyTotal: Math.round(envTotal(ENV_MULTIPLIERS.test) * 12 * 100) / 100, description: `test (${ENV_MULTIPLIERS.test * 100}% traffic)` },
        prod: { monthlyTotal: envTotal(ENV_MULTIPLIERS.prod), yearlyTotal: Math.round(envTotal(ENV_MULTIPLIERS.prod) * 12 * 100) / 100, description: `production (${ENV_MULTIPLIERS.prod * 100}% traffic)` },
        activeProfile: usageProfile,
      };

      const result: CostAnalysisResult = {
        success: true,
        summary: {
          monthlyTotalExact: Math.round(monthlyTotalExact * 100) / 100,
          monthlyTotalEstimated: Math.round(monthlyTotalEstimated * 100) / 100,
          monthlyGrandTotal: Math.round(monthlyGrandTotal * 100) / 100,
          yearlyGrandTotal: Math.round(yearlyGrandTotal * 100) / 100,
          currency: 'USD',
          exactCount: exactResources.length,
          estimatedCount: estimatedResources.length,
          needsInputCount: needsInputResources.length,
          freeCount: freeResources.length,
          resourceCount: costEstimates.length,
          profile: requestProfile,
        },
        resources: costEstimates,
        skippedResources,
        environmentComparison,
      };

      res.json(result);

    } catch (error: any) {
      console.error('❌ Error in cost analysis:', error);
      console.error('   Error stack:', error.stack);
      res.status(500).json({
        success: false,
        error: 'Failed to analyze costs',
        details: error.message || 'Unknown error occurred',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  });
}
