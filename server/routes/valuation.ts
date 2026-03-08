/**
 * Valuation Module API Routes
 *
 * Endpoints for live Azure resource analysis and cost optimization recommendations.
 */

import type { Express } from "express";
import { storage } from "../storage";
import { fetchAzureResources, validateAzureConnection, fetchResourceGroups } from "../valuation/resource-fetcher";
import { mapAzureResourceToTerraformType, extractPricingAttributes, calculateResourceCost } from "../valuation/pricing-mapper";
import { generateRecommendation, calculateTotalSavings } from "../valuation/recommendation-engine";
import { fetchMetricsForResources } from "../valuation/metrics-fetcher";
import type { ValuationResource, ValuationSummary, UsageMetrics } from "@shared/schema";

export function registerValuationRoutes(app: Express): void {

  // POST /api/valuation/connect - Verify Azure connection
  app.post("/api/valuation/connect", async (req, res) => {
    try {
      console.log('\n🔌 ========== VALUATION: CONNECT ==========');

      // Get userId from session if available (for Bitwarden)
      const { sessionId } = req.body;
      let userId: string | undefined;

      if (sessionId) {
        const session = await storage.getSession(sessionId);
        userId = session?.userId || undefined;
      }

      const isConnected = await validateAzureConnection(userId);

      if (!isConnected) {
        return res.status(400).json({
          error: 'Azure connection failed',
          details: 'Could not connect to Azure. Please configure credentials in Settings or set environment variables (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, AZURE_SUBSCRIPTION_ID).'
        });
      }

      res.json({
        success: true,
        subscriptionId: process.env.AZURE_SUBSCRIPTION_ID || 'unknown'
      });

    } catch (error: any) {
      console.error('❌ Connection test failed:', error);
      res.status(500).json({
        error: 'Connection test failed',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // POST /api/valuation/resource-groups - Get list of resource groups
  app.post("/api/valuation/resource-groups", async (req, res) => {
    try {
      console.log('\n📦 ========== VALUATION: RESOURCE GROUPS ==========');

      // Get userId from session if available (for Bitwarden)
      const { sessionId } = req.body;
      let userId: string | undefined;

      if (sessionId) {
        const session = await storage.getSession(sessionId);
        userId = session?.userId || undefined;
      }

      const resourceGroups = await fetchResourceGroups(userId);

      res.json({
        success: true,
        resourceGroups
      });

    } catch (error: any) {
      console.error('❌ Resource groups fetch failed:', error);
      res.status(500).json({
        error: 'Resource groups fetch failed',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // POST /api/valuation/scan - Scan Azure resources
  app.post("/api/valuation/scan", async (req, res) => {
    try {
      const { sessionId, resourceGroupIds } = req.body;

      console.log(`\n🔍 ========== VALUATION: SCAN ==========`);
      console.log(`Session ID: ${sessionId}`);
      if (resourceGroupIds && resourceGroupIds.length > 0) {
        console.log(`Resource Groups: ${resourceGroupIds.length} selected`);
      }

      if (!sessionId) {
        return res.status(400).json({
          error: 'Session ID is required',
          details: 'Please provide a valid session ID'
        });
      }

      // Get userId from session (for Bitwarden)
      const session = await storage.getSession(sessionId);
      const userId = session?.userId || undefined;

      // Fetch resources from Azure (optionally filtered by resource groups)
      const resources = await fetchAzureResources(userId, resourceGroupIds);

      // Store in session for later analysis
      await storage.updateSession(sessionId, {
        scannedResources: JSON.stringify(resources),
        selectedResourceGroups: resourceGroupIds ? JSON.stringify(resourceGroupIds) : null,
        scanTimestamp: new Date().toISOString()
      });

      console.log(`✅ Scan complete: ${resources.length} resource(s) stored in session`);

      res.json({
        success: true,
        scannedCount: resources.length,
        resources
      });

    } catch (error: any) {
      console.error('❌ Resource scan failed:', error);
      res.status(500).json({
        error: 'Resource scan failed',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // POST /api/valuation/analyze - Analyze costs and generate recommendations
  app.post("/api/valuation/analyze", async (req, res) => {
    try {
      const { sessionId, fetchMetrics = true } = req.body;

      console.log(`\n💰 ========== VALUATION: ANALYZE ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Fetch Metrics: ${fetchMetrics}`);

      if (!sessionId) {
        return res.status(400).json({
          error: 'Session ID is required',
          details: 'Please provide a valid session ID'
        });
      }

      // Get scanned resources from session
      const session = await storage.getSession(sessionId);

      if (!session || !session.scannedResources) {
        return res.status(400).json({
          error: 'No scanned resources found',
          details: 'Please run a resource scan first before analyzing costs'
        });
      }

      const azureResources = JSON.parse(session.scannedResources);
      const userId = session?.userId || undefined;
      console.log(`📋 Analyzing ${azureResources.length} resource(s)...`);

      // Fetch usage metrics if requested
      let metricsMap = new Map<string, UsageMetrics>();
      if (fetchMetrics) {
        try {
          // Load Azure credentials to get access token
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

          const tokenResponse = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
          });

          if (tokenResponse.ok) {
            const tokenData = await tokenResponse.json();
            const accessToken = tokenData.access_token;

            // Prepare resources for metrics fetching
            const resourcesForMetrics = azureResources
              .filter((r: any) => r.type) // Only resources with type
              .map((r: any) => ({ id: r.id, type: r.type }));

            metricsMap = await fetchMetricsForResources(resourcesForMetrics, accessToken);
            console.log(`   ✅ Fetched metrics for ${metricsMap.size} resource(s)`);

            // Cache metrics in session
            const metricsCache = Array.from(metricsMap.entries()).map(([id, metrics]) => ({ id, metrics }));
            await storage.updateSession(sessionId, {
              usageMetricsCache: JSON.stringify(metricsCache)
            });
          }
        } catch (metricsError: any) {
          console.warn(`   ⚠️  Failed to fetch metrics: ${metricsError.message}`);
          console.log(`   ℹ️  Continuing with rule-based recommendations...`);
        }
      }

      const valuationResources: ValuationResource[] = [];

      // Process each resource
      for (const azureResource of azureResources) {
        try {
          // Map to Terraform type
          const terraformType = mapAzureResourceToTerraformType(azureResource.type);

          if (!terraformType) {
            console.log(`   ⚠️  Skipping unsupported resource type: ${azureResource.type}`);
            continue;
          }

          // Use actual cost if available, otherwise estimate from pricing API
          let monthlyCost: number;
          let yearlyCost: number;
          let pricingDetails: any;

          if (azureResource.actualCostMTD !== undefined && azureResource.actualCostMTD > 0) {
            // Use actual cost from Azure Cost Management (month-to-date)
            const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
            const currentDay = new Date().getDate();
            const monthlyProjection = (azureResource.actualCostMTD / currentDay) * daysInMonth;

            monthlyCost = monthlyProjection;
            yearlyCost = monthlyProjection * 12;
            pricingDetails = {
              source: 'Azure Cost Management (Actual)',
              mtdCost: azureResource.actualCostMTD,
              daysElapsed: currentDay,
              projectedMonthly: monthlyProjection
            };

            console.log(`   💰 ${azureResource.name} - Actual MTD Cost: ₹${azureResource.actualCostMTD.toFixed(2)}, Projected Monthly: ₹${monthlyProjection.toFixed(2)}`);
          } else {
            // Fallback to estimated pricing
            const attributes = extractPricingAttributes(azureResource, terraformType);
            console.log(`   📊 ${azureResource.name} - Attributes:`, JSON.stringify(attributes, null, 2));

            const result = await calculateResourceCost(
              terraformType,
              attributes,
              azureResource.location
            );

            monthlyCost = result.monthlyCost;
            yearlyCost = result.yearlyCost;
            pricingDetails = result.pricingDetails;

            if (pricingDetails && !pricingDetails.freeReason) {
              console.log(`   💰 ${azureResource.name} - Estimated Pricing:`, {
                productName: pricingDetails.productName,
                skuName: pricingDetails.skuName,
                meterName: pricingDetails.meterName,
                unitPrice: pricingDetails.unitPrice,
                unitOfMeasure: pricingDetails.unitOfMeasure
              });
            }
          }

          // Get usage metrics for this resource
          const resourceMetrics = metricsMap.get(azureResource.id);

          // Create valuation resource
          const valuationResource: ValuationResource = {
            id: azureResource.id,
            name: azureResource.name,
            type: azureResource.type.split('/').pop() || azureResource.type,
            azureType: azureResource.type,
            terraformType,
            location: azureResource.location,
            resourceGroup: azureResource.resourceGroup,
            currentSku: azureResource.sku || 'Unknown',
            currentTier: azureResource.tier,
            monthlyCost,
            yearlyCost,
            currency: 'INR',
            pricingDetails,
            usageMetrics: resourceMetrics,
            metricsAvailable: !!resourceMetrics
          };

          // Generate cost optimization recommendation (with metrics if available)
          const remediation = generateRecommendation(valuationResource, monthlyCost, resourceMetrics);
          valuationResource.remediation = remediation || undefined;

          valuationResources.push(valuationResource);

          console.log(`   ✅ ${azureResource.name}: $${monthlyCost.toFixed(2)}/month` +
            (valuationResource.remediation ? ` (Save ${valuationResource.remediation.savings_percent}%)` : ''));

        } catch (resourceError: any) {
          console.error(`   ❌ Failed to analyze ${azureResource.name}:`, resourceError.message);
          // Continue with other resources
        }
      }

      // Calculate savings summary
      const savings = calculateTotalSavings(valuationResources);
      const totalMonthlyCost = valuationResources.reduce((sum, r) => sum + r.monthlyCost, 0);

      const summary: ValuationSummary = {
        totalMonthlyCost,
        totalYearlyCost: totalMonthlyCost * 12,
        potentialSavings: savings.totalMonthlySavings,
        savingsPercent: totalMonthlyCost > 0
          ? Math.round((savings.totalMonthlySavings / totalMonthlyCost) * 100)
          : 0,
        resourceCount: valuationResources.length,
        recommendationCount: savings.resourcesWithRecommendations
      };

      console.log(`\n📊 Analysis Summary:`);
      console.log(`   Total Monthly Cost: $${summary.totalMonthlyCost.toFixed(2)}`);
      console.log(`   Potential Savings: $${summary.potentialSavings.toFixed(2)}/month (${summary.savingsPercent}%)`);
      console.log(`   Resources Analyzed: ${summary.resourceCount}`);
      console.log(`   Recommendations: ${summary.recommendationCount}`);

      res.json({
        success: true,
        summary,
        resources: valuationResources
      });

    } catch (error: any) {
      console.error('❌ Cost analysis failed:', error);
      res.status(500).json({
        error: 'Cost analysis failed',
        details: error.message || 'Unknown error occurred'
      });
    }
  });

  // ─── FinOps: Reserved Instance Advisor ─────────────────────────────────────
  // POST /api/valuation/reserved-instances
  // Accepts the already-analyzed resources array from Step 4 and applies
  // Azure/AWS/GCP reserved-pricing discount rates to produce RI recommendations.
  app.post("/api/valuation/reserved-instances", async (req, res) => {
    try {
      const { resources } = req.body;

      if (!resources || !Array.isArray(resources)) {
        return res.status(400).json({ error: 'Resources array is required' });
      }

      console.log(`\n💡 ========== VALUATION: RESERVED INSTANCES ==========`);
      console.log(`   Analysing ${resources.length} resource(s) for RI eligibility`);

      // Discount rates per terraform resource type.
      // Source: Azure public pricing pages (1-yr no-upfront / 3-yr no-upfront).
      const RI_DISCOUNTS: Record<string, { oneYr: number; threeYr: number; commitmentType: string }> = {
        'azurerm_linux_virtual_machine':      { oneYr: 0.36, threeYr: 0.58, commitmentType: 'Reserved Instance' },
        'azurerm_windows_virtual_machine':    { oneYr: 0.36, threeYr: 0.58, commitmentType: 'Reserved Instance' },
        'azurerm_virtual_machine':            { oneYr: 0.36, threeYr: 0.58, commitmentType: 'Reserved Instance' },
        'azurerm_kubernetes_cluster':         { oneYr: 0.36, threeYr: 0.58, commitmentType: 'Reserved Instance' },
        'azurerm_app_service_plan':           { oneYr: 0.31, threeYr: 0.49, commitmentType: 'Reserved Instance' },
        'azurerm_service_plan':               { oneYr: 0.31, threeYr: 0.49, commitmentType: 'Reserved Instance' },
        'azurerm_mssql_database':             { oneYr: 0.33, threeYr: 0.54, commitmentType: 'Reserved Capacity' },
        'azurerm_postgresql_flexible_server': { oneYr: 0.33, threeYr: 0.54, commitmentType: 'Reserved Capacity' },
        'azurerm_mysql_flexible_server':      { oneYr: 0.33, threeYr: 0.54, commitmentType: 'Reserved Capacity' },
        'azurerm_redis_cache':                { oneYr: 0.33, threeYr: 0.54, commitmentType: 'Reserved Capacity' },
      };

      const recommendations: any[] = [];
      let totalOnDemandMonthly = 0;
      let totalReservedMonthly = 0;
      let skippedCount = 0;

      for (const resource of resources) {
        const discount = RI_DISCOUNTS[resource.terraformType];
        if (!discount || !resource.monthlyCost || resource.monthlyCost <= 0) {
          skippedCount++;
          continue;
        }

        const saving1YrMonthly   = parseFloat((resource.monthlyCost * discount.oneYr).toFixed(2));
        const reservedMonthly1Yr = parseFloat((resource.monthlyCost - saving1YrMonthly).toFixed(2));
        const saving3YrMonthly   = parseFloat((resource.monthlyCost * discount.threeYr).toFixed(2));
        const reservedMonthly3Yr = parseFloat((resource.monthlyCost - saving3YrMonthly).toFixed(2));
        const saving1YrPercent   = Math.round(discount.oneYr * 100);
        const saving3YrPercent   = Math.round(discount.threeYr * 100);

        totalOnDemandMonthly += resource.monthlyCost;
        totalReservedMonthly += reservedMonthly1Yr;

        recommendations.push({
          resourceName:      resource.name,
          resourceType:      resource.terraformType,
          region:            resource.location,
          currentSku:        resource.currentSku || 'Unknown',
          onDemandMonthly:   resource.monthlyCost,
          reservedMonthly1Yr,
          reservedMonthly3Yr,
          saving1YrMonthly,
          saving1YrAnnual:   parseFloat((saving1YrMonthly * 12).toFixed(2)),
          saving1YrPercent,
          saving3YrMonthly,
          saving3YrAnnual:   parseFloat((saving3YrMonthly * 12).toFixed(2)),
          saving3YrPercent,
          commitmentType:    discount.commitmentType,
          recommendation:    saving1YrPercent >= 30 ? 'strong' : saving1YrPercent >= 20 ? 'moderate' : 'review',
          rationale: `Switch to 1-year ${discount.commitmentType} to save ${saving1YrPercent}% — ₹${saving1YrMonthly.toFixed(0)}/month (₹${(saving1YrMonthly * 12).toFixed(0)}/year).`,
        });
      }

      const totalSavingMonthly = parseFloat((totalOnDemandMonthly - totalReservedMonthly).toFixed(2));

      console.log(`   ✅ ${recommendations.length} eligible, ${skippedCount} skipped`);
      console.log(`   💰 Potential saving: ₹${totalSavingMonthly.toFixed(2)}/month`);

      res.json({
        recommendations,
        totalOnDemandMonthly: parseFloat(totalOnDemandMonthly.toFixed(2)),
        totalReservedMonthly: parseFloat(totalReservedMonthly.toFixed(2)),
        totalSavingMonthly,
        totalSavingAnnual: parseFloat((totalSavingMonthly * 12).toFixed(2)),
        eligibleCount:  recommendations.length,
        skippedCount,
      });

    } catch (error: any) {
      console.error('❌ Reserved instance analysis failed:', error);
      res.status(500).json({ error: 'Reserved instance analysis failed', details: error.message });
    }
  });

  // ─── FinOps: Budget Alert Generator ─────────────────────────────────────────
  // POST /api/valuation/budget-alerts
  // Creates a real Azure Budget Alert via the Cost Management REST API.
  app.post("/api/valuation/budget-alerts", async (req, res) => {
    try {
      const {
        sessionId,
        monthlyBudget,
        emails,
        thresholds = [80, 100, 120],
        resourceGroupName,
      } = req.body;

      if (!monthlyBudget || isNaN(Number(monthlyBudget))) {
        return res.status(400).json({ error: 'monthlyBudget (number) is required' });
      }

      const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
      const tenantId      = process.env.AZURE_TENANT_ID;
      const clientId      = process.env.AZURE_CLIENT_ID;
      const clientSecret  = process.env.AZURE_CLIENT_SECRET;

      if (!subscriptionId || !tenantId || !clientId || !clientSecret) {
        return res.status(400).json({
          error: 'Azure credentials not configured',
          details: 'Set AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET.'
        });
      }

      console.log(`\n🔔 ========== VALUATION: BUDGET ALERTS (Azure API) ==========`);
      console.log(`   Budget: $${monthlyBudget}/month | Thresholds: ${(thresholds as number[]).join('%, ')}%`);

      const budget = Number(monthlyBudget);
      const emailList: string[] = Array.isArray(emails)
        ? emails.filter(Boolean)
        : typeof emails === 'string'
          ? emails.split(',').map((e: string) => e.trim()).filter(Boolean)
          : [];

      // Get Azure access token
      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
      const tokenBody = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://management.azure.com/.default',
        grant_type: 'client_credentials',
      });
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
      });
      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Failed to authenticate with Azure: ${errText}`);
      }
      const { access_token } = await tokenRes.json() as { access_token: string };

      // Determine scope
      const scope = resourceGroupName
        ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`
        : `/subscriptions/${subscriptionId}`;

      const budgetName = `aicloudbuilder-budget-${Date.now()}`;
      const now = new Date();
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate   = `${now.getFullYear() + 2}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

      // Build notifications map — one entry per threshold
      const notifications: Record<string, object> = {};
      for (const t of thresholds as number[]) {
        notifications[`Actual_GreaterThan_${t}_Percent`] = {
          enabled: true,
          operator: t > 100 ? 'GreaterThanOrEqualTo' : 'GreaterThan',
          threshold: t,
          thresholdType: 'Actual',
          ...(emailList.length > 0 ? { contactEmails: emailList } : {}),
        };
      }

      const budgetUrl = `https://management.azure.com${scope}/providers/Microsoft.Consumption/budgets/${budgetName}?api-version=2021-10-01`;
      const budgetRes = await fetch(budgetUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            category: 'Cost',
            amount: budget,
            timeGrain: 'Monthly',
            timePeriod: { startDate, endDate },
            notifications,
          },
        }),
      });

      if (!budgetRes.ok) {
        const errText = await budgetRes.text();
        throw new Error(`Azure Budget API error (${budgetRes.status}): ${errText}`);
      }

      const budgetData = await budgetRes.json() as { id?: string };
      const scopeLabel = resourceGroupName
        ? `Resource Group: ${resourceGroupName}`
        : `Subscription: ${subscriptionId}`;

      console.log(`   ✅ Budget created: ${budgetName} (${scopeLabel})`);

      res.json({
        success: true,
        budgetName,
        budgetId: budgetData.id ?? `${scope}/providers/Microsoft.Consumption/budgets/${budgetName}`,
        amount: budget,
        scope: scopeLabel,
        thresholds,
        emailCount: emailList.length,
        emails: emailList,
        createdAt: new Date().toISOString(),
        portalUrl: `https://portal.azure.com/#blade/Microsoft_Azure_CostManagement/BudgetListBlade`,
      });

    } catch (error: any) {
      console.error('❌ Budget alert creation failed:', error);
      res.status(500).json({ error: 'Budget alert creation failed', details: error.message });
    }
  });

  // ─── FinOps: Multi-Cloud Price Comparator ───────────────────────────────────
  // POST /api/valuation/multicloud-compare
  // Uses static equivalent-price ratios to estimate the same workload cost on
  // AWS and GCP, given already-calculated Azure costs from Step 4.
  app.post("/api/valuation/multicloud-compare", async (req, res) => {
    try {
      const { resources } = req.body;

      if (!resources || !Array.isArray(resources)) {
        return res.status(400).json({ error: 'Resources array is required' });
      }

      console.log(`\n🌍 ========== VALUATION: MULTI-CLOUD COMPARE ==========`);
      console.log(`   Comparing ${resources.length} resource(s) across Azure / AWS / GCP`);

      // Equivalent-cost ratios relative to Azure on-demand price.
      // Based on public on-demand pricing (us-east-1 / us-central1 vs eastus).
      // Source: Vendor pricing pages, last validated 2026-03.
      const MULTICLOUD_RATIOS: Record<string, { aws: number; gcp: number; awsLabel: string; gcpLabel: string }> = {
        'azurerm_linux_virtual_machine':      { aws: 0.87, gcp: 0.80, awsLabel: 'EC2 (m-series)',         gcpLabel: 'Compute Engine (n2)' },
        'azurerm_windows_virtual_machine':    { aws: 0.90, gcp: 0.86, awsLabel: 'EC2 Windows',            gcpLabel: 'Compute Engine Windows' },
        'azurerm_virtual_machine':            { aws: 0.87, gcp: 0.80, awsLabel: 'EC2',                    gcpLabel: 'Compute Engine' },
        'azurerm_kubernetes_cluster':         { aws: 0.85, gcp: 0.75, awsLabel: 'EKS',                    gcpLabel: 'GKE' },
        'azurerm_app_service_plan':           { aws: 0.88, gcp: 0.82, awsLabel: 'Elastic Beanstalk / EC2', gcpLabel: 'App Engine' },
        'azurerm_service_plan':               { aws: 0.88, gcp: 0.82, awsLabel: 'Elastic Beanstalk / EC2', gcpLabel: 'App Engine' },
        'azurerm_mssql_database':             { aws: 0.92, gcp: 0.88, awsLabel: 'RDS SQL Server',          gcpLabel: 'Cloud SQL (SQL Server)' },
        'azurerm_postgresql_flexible_server': { aws: 0.88, gcp: 0.82, awsLabel: 'RDS PostgreSQL',          gcpLabel: 'Cloud SQL PostgreSQL' },
        'azurerm_mysql_flexible_server':      { aws: 0.88, gcp: 0.82, awsLabel: 'RDS MySQL',               gcpLabel: 'Cloud SQL MySQL' },
        'azurerm_redis_cache':                { aws: 0.90, gcp: 0.85, awsLabel: 'ElastiCache Redis',        gcpLabel: 'Memorystore Redis' },
        'azurerm_storage_account':            { aws: 0.85, gcp: 0.78, awsLabel: 'S3',                       gcpLabel: 'Cloud Storage' },
        'azurerm_container_registry':         { aws: 0.70, gcp: 0.60, awsLabel: 'ECR',                      gcpLabel: 'Artifact Registry' },
        'azurerm_linux_web_app':              { aws: 0.88, gcp: 0.82, awsLabel: 'Elastic Beanstalk',        gcpLabel: 'App Engine' },
        'azurerm_managed_disk':               { aws: 0.90, gcp: 0.82, awsLabel: 'EBS',                      gcpLabel: 'Persistent Disk' },
        'azurerm_container_group':            { aws: 0.85, gcp: 0.78, awsLabel: 'ECS Fargate',              gcpLabel: 'Cloud Run' },
      };

      const lineItems: any[] = [];
      let azureTotal = 0;
      let awsTotal   = 0;
      let gcpTotal   = 0;

      for (const resource of resources) {
        if (!resource.monthlyCost || resource.monthlyCost <= 0) continue;
        const ratios = MULTICLOUD_RATIOS[resource.terraformType];
        if (!ratios) continue;

        const awsMonthly = parseFloat((resource.monthlyCost * ratios.aws).toFixed(2));
        const gcpMonthly = parseFloat((resource.monthlyCost * ratios.gcp).toFixed(2));

        azureTotal += resource.monthlyCost;
        awsTotal   += awsMonthly;
        gcpTotal   += gcpMonthly;

        lineItems.push({
          resourceName:  resource.name,
          role:          resource.type || resource.terraformType,
          azureSku:      resource.currentSku || 'Unknown',
          azureMonthly:  resource.monthlyCost,
          awsEquivalent: ratios.awsLabel,
          awsMonthly,
          gcpEquivalent: ratios.gcpLabel,
          gcpMonthly,
        });
      }

      const totals = {
        azure: parseFloat(azureTotal.toFixed(2)),
        aws:   parseFloat(awsTotal.toFixed(2)),
        gcp:   parseFloat(gcpTotal.toFixed(2)),
      };

      const cheapestProvider = (Object.entries(totals) as [string, number][])
        .sort(([, a], [, b]) => a - b)[0][0] as 'azure' | 'aws' | 'gcp';

      const insights: string[] = [];
      const cheapestCost = totals[cheapestProvider];

      if (cheapestProvider === 'gcp') {
        insights.push(`GCP is cheapest at ₹${gcpTotal.toFixed(0)}/month — ₹${(azureTotal - gcpTotal).toFixed(0)} less than your current Azure spend`);
      } else if (cheapestProvider === 'aws') {
        insights.push(`AWS is cheaper than Azure by ₹${(azureTotal - awsTotal).toFixed(0)}/month for this workload`);
      } else {
        insights.push(`Azure is the most cost-effective option for this workload`);
      }

      insights.push(`Annual savings vs Azure: AWS saves ₹${((azureTotal - awsTotal) * 12).toFixed(0)}, GCP saves ₹${((azureTotal - gcpTotal) * 12).toFixed(0)}`);
      insights.push(`All three clouds offer 30–58% additional savings with reserved/committed-use pricing`);
      insights.push(`Estimates based on equivalent on-demand rates. Actual costs depend on region, data transfer, and support tier`);

      console.log(`   ✅ ${lineItems.length} resource(s) compared | Azure ₹${azureTotal.toFixed(0)} | AWS ₹${awsTotal.toFixed(0)} | GCP ₹${gcpTotal.toFixed(0)}`);
      console.log(`   🏆 Cheapest: ${cheapestProvider}`);

      res.json({
        lineItems,
        totals,
        annualTotals: {
          azure: parseFloat((azureTotal * 12).toFixed(2)),
          aws:   parseFloat((awsTotal   * 12).toFixed(2)),
          gcp:   parseFloat((gcpTotal   * 12).toFixed(2)),
        },
        cheapestProvider,
        savingVsAzure: {
          aws: parseFloat((azureTotal - awsTotal).toFixed(2)),
          gcp: parseFloat((azureTotal - gcpTotal).toFixed(2)),
        },
        insights,
        resourceCount: lineItems.length,
      });

    } catch (error: any) {
      console.error('❌ Multi-cloud comparison failed:', error);
      res.status(500).json({ error: 'Multi-cloud comparison failed', details: error.message });
    }
  });
}
