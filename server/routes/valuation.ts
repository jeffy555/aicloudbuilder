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
}
