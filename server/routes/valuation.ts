/**
 * Valuation Module API Routes
 *
 * Endpoints for live Azure resource analysis and cost optimization recommendations.
 */

import type { Express } from "express";
import { aiChatCompletion } from '../utils/ai-client.js';
import { storage } from "../storage";
import { fetchAzureResources, validateAzureConnection, fetchResourceGroups } from "../valuation/resource-fetcher";
import { mapAzureResourceToTerraformType, extractPricingAttributes, calculateResourceCost } from "../valuation/pricing-mapper";
import { generateAIRecommendations, calculateTotalSavings } from "../valuation/recommendation-engine";
import { fetchMetricsForResources } from "../valuation/metrics-fetcher";
import type { ValuationResource, ValuationSummary, UsageMetrics } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import { requireAuth, optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { aiMediumLimiter } from "../middleware/rate-limit";
import {
  valuationConnectBody,
  resourceGroupsBody,
  valuationScanBody,
  valuationAnalyzeBody,
  reservedInstancesBody,
  budgetAlertsBody,
  multicloudCompareBody,
} from "@shared/api-contracts/valuation";

export function registerValuationRoutes(app: Express): void {

  // POST /api/valuation/connect - Verify Azure connection
  app.post("/api/valuation/connect", optionalAuth, validateRequest({ body: valuationConnectBody }), async (req, res) => {
    try {
      console.log('\n🔌 ========== VALUATION: CONNECT ==========');

      // Get userId from session if available (for Bitwarden)
      const { sessionId } = req.body;
      let userId: string | undefined = (req as AuthenticatedRequest).userId;

      if (!userId && sessionId) {
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

      // Audit log
      try {
        if (userId) {
          await storage.createUserActivity({
            userId,
            sessionId: sessionId || null,
            module: 'valuation',
            actionType: 'valuation_connect',
            actionLabel: 'Connected to Azure subscription',
            metadata: { subscriptionId: process.env.AZURE_SUBSCRIPTION_ID || 'unknown' },
          });
        }
      } catch (_auditErr) { /* audit failure should not break endpoint */ }

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
  app.post("/api/valuation/resource-groups", optionalAuth, validateRequest({ body: resourceGroupsBody }), async (req, res) => {
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
  app.post("/api/valuation/scan", optionalAuth, validateRequest({ body: valuationScanBody }), async (req, res) => {
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
      const userId = (req as AuthenticatedRequest).userId || session?.userId || undefined;

      // Fetch resources from Azure (optionally filtered by resource groups)
      const resources = await fetchAzureResources(userId, resourceGroupIds);

      // Store in session for later analysis
      await storage.updateSession(sessionId, {
        scannedResources: JSON.stringify(resources),
        selectedResourceGroups: resourceGroupIds ? JSON.stringify(resourceGroupIds) : null,
        scanTimestamp: new Date().toISOString()
      });

      console.log(`✅ Scan complete: ${resources.length} resource(s) stored in session`);

      // Audit log
      try {
        if (userId) {
          await storage.createUserActivity({
            userId,
            sessionId,
            module: 'valuation',
            actionType: 'valuation_scan',
            actionLabel: `Scanned ${resources.length} resources from ${resourceGroupIds?.length || 'all'} resource groups`,
            metadata: { scannedCount: resources.length, resourceGroupCount: resourceGroupIds?.length || 0 },
          });
        }
      } catch (_auditErr) { /* audit failure should not break endpoint */ }

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
  app.post("/api/valuation/analyze", optionalAuth, aiMediumLimiter, validateRequest({ body: valuationAnalyzeBody }), async (req, res) => {
    try {
      const VALID_CURRENCIES = ['USD', 'INR', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'KRW', 'BRL', 'MXN', 'SGD', 'HKD', 'NOK', 'SEK', 'DKK', 'NZD', 'ZAR', 'AED'] as const;
      const { sessionId, fetchMetrics = true, currency: rawCurrency = 'INR' } = req.body;
      const currency = VALID_CURRENCIES.includes(rawCurrency) ? rawCurrency : 'USD';

      console.log(`\n💰 ========== VALUATION: ANALYZE ==========`);
      console.log(`Session ID: ${sessionId}`);
      console.log(`Fetch Metrics: ${fetchMetrics}`);
      console.log(`Currency: ${currency}`);

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
      const userId = (req as AuthenticatedRequest).userId || session?.userId || undefined;
      console.log(`📋 Analyzing ${azureResources.length} resource(s)...`);

      // Fetch usage metrics if requested
      let metricsMap = new Map<string, UsageMetrics>();
      let metricsWarning: string | undefined;
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

            // Prepare resources for metrics fetching (include vmSize for accurate memory calculations)
            const resourcesForMetrics = azureResources
              .filter((r: any) => r.type) // Only resources with type
              .map((r: any) => ({
                id: r.id,
                type: r.type,
                vmSize: r.properties?.hardwareProfile?.vmSize || undefined
              }));

            metricsMap = await fetchMetricsForResources(resourcesForMetrics, accessToken);
            console.log(`   ✅ Fetched metrics for ${metricsMap.size} resource(s)`);

            // Cache metrics in session
            const metricsCache = Array.from(metricsMap.entries()).map(([id, metrics]) => ({ id, metrics }));
            await storage.updateSession(sessionId, {
              usageMetricsCache: JSON.stringify(metricsCache)
            });
          } else {
            metricsWarning = `Azure Monitor token fetch failed (${tokenResponse.status}). Using rule-based recommendations (lower confidence).`;
            console.warn(`   ⚠️  ${metricsWarning}`);
          }
        } catch (metricsError: any) {
          console.warn(`   ⚠️  Failed to fetch metrics: ${metricsError.message}`);
          metricsWarning = `Azure Monitor metrics unavailable: ${metricsError.message}. Using rule-based recommendations (lower confidence).`;
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
          let pricingError = false;

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
              azureResource.location,
              currency
            );

            monthlyCost = result.monthlyCost;
            yearlyCost = result.yearlyCost;
            pricingDetails = result.pricingDetails;
            pricingError = result.pricingError || false;

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
            currency,
            pricingDetails,
            pricingError,
            usageMetrics: resourceMetrics,
            metricsAvailable: !!resourceMetrics
          };

          valuationResources.push(valuationResource);

          console.log(`   ✅ ${azureResource.name}: $${monthlyCost.toFixed(2)}/month`);

        } catch (resourceError: any) {
          console.error(`   ❌ Failed to analyze ${azureResource.name}:`, resourceError.message);
          // Continue with other resources
        }
      }

      // Generate AI-powered recommendations for all resources at once
      try {
        const aiInput = valuationResources.map(r => ({
          resource: r,
          monthlyCost: r.monthlyCost,
          metrics: r.usageMetrics,
        }));

        const aiRecommendations = await generateAIRecommendations(aiInput, currency);

        // Apply AI recommendations to resources
        for (const r of valuationResources) {
          const rec = aiRecommendations.get(r.name);
          if (rec) {
            r.remediation = rec;
            console.log(`   💡 ${r.name}: Save ${rec.savings_percent}% → ${rec.recommended_sku}`);
          }
        }
      } catch (aiError: any) {
        console.warn(`   ⚠️  AI recommendation engine failed: ${aiError.message}`);
        // Resources will have no recommendations — better than wrong hardcoded ones
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

      const pricingWarnings = valuationResources.filter(r => (r as any).pricingError).length;

      console.log(`\n📊 Analysis Summary:`);
      console.log(`   Total Monthly Cost: $${summary.totalMonthlyCost.toFixed(2)}`);
      console.log(`   Potential Savings: $${summary.potentialSavings.toFixed(2)}/month (${summary.savingsPercent}%)`);
      console.log(`   Resources Analyzed: ${summary.resourceCount}`);
      console.log(`   Recommendations: ${summary.recommendationCount}`);
      if (pricingWarnings > 0) console.log(`   Pricing Warnings: ${pricingWarnings}`);

      // Audit log
      try {
        if (userId) {
          await storage.createUserActivity({
            userId,
            sessionId,
            module: 'valuation',
            actionType: 'valuation_analyze',
            actionLabel: `Analyzed ${valuationResources.length} resources, found ${summary.recommendationCount} recommendations`,
            metadata: { resourceCount: valuationResources.length, recommendationCount: summary.recommendationCount, currency },
          });
        }
      } catch (_auditErr) { /* audit failure should not break endpoint */ }

      res.json({
        success: true,
        summary,
        resources: valuationResources,
        metricsWarning,
        pricingWarnings,
        currency
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
  app.post("/api/valuation/reserved-instances", optionalAuth, aiMediumLimiter, validateRequest({ body: reservedInstancesBody }), async (req, res) => {
    try {
      const { resources } = req.body;

      if (!resources || !Array.isArray(resources)) {
        return res.status(400).json({ error: 'Resources array is required' });
      }

      console.log(`\n💡 ========== VALUATION: RESERVED INSTANCES ==========`);
      console.log(`   Analysing ${resources.length} resource(s) for RI eligibility`);

      // Build resource summary for AI
      const resourceSummary = resources
        .filter((r: any) => r.monthlyCost > 0)
        .map((r: any) => ({
          name: r.name,
          type: r.terraformType || r.azureType,
          sku: r.currentSku,
          region: r.location,
          monthlyCost: r.monthlyCost,
          currency: r.currency || 'INR',
        }));

      const riCompletion = await aiChatCompletion({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 6000,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are an Azure Reserved Instance pricing advisor. For each resource, calculate the 1-year and 3-year reserved instance/capacity savings based on current Azure RI pricing for the specific SKU and region. Use real Azure RI discount rates — they vary by resource type, SKU size, and region. Resources that are not eligible for reservations (e.g. storage accounts, container registries) should be skipped.

Return JSON with this exact structure:
{
  "recommendations": [
    {
      "resourceName": "string",
      "resourceType": "string",
      "region": "string",
      "currentSku": "string",
      "onDemandMonthly": number,
      "reservedMonthly1Yr": number,
      "reservedMonthly3Yr": number,
      "saving1YrMonthly": number,
      "saving1YrAnnual": number,
      "saving1YrPercent": number,
      "saving3YrMonthly": number,
      "saving3YrAnnual": number,
      "saving3YrPercent": number,
      "commitmentType": "Reserved Instance" | "Reserved Capacity" | "Savings Plan",
      "recommendation": "strong" | "moderate" | "review",
      "rationale": "detailed explanation with specific numbers"
    }
  ],
  "summary": {
    "totalOnDemandMonthly": number,
    "totalReservedMonthly": number,
    "totalSavingMonthly": number,
    "totalSavingAnnual": number,
    "eligibleCount": number,
    "skippedCount": number
  }
}`
          },
          {
            role: 'user',
            content: `Analyze these ${resourceSummary.length} Azure resources for RI eligibility:\n${JSON.stringify(resourceSummary, null, 2)}`
          }
        ]
      });

      const riContent = riCompletion.choices[0]?.message?.content;
      if (!riContent) {
        return res.status(500).json({ error: 'AI returned empty response for RI analysis' });
      }

      const riResult = JSON.parse(riContent) as {
        recommendations: any[];
        summary: {
          totalOnDemandMonthly: number;
          totalReservedMonthly: number;
          totalSavingMonthly: number;
          totalSavingAnnual: number;
          eligibleCount: number;
          skippedCount: number;
        };
      };

      console.log(`   ✅ ${riResult.summary?.eligibleCount || riResult.recommendations?.length || 0} eligible, ${riResult.summary?.skippedCount || 0} skipped`);
      console.log(`   💰 Potential saving: ₹${(riResult.summary?.totalSavingMonthly || 0).toFixed(2)}/month`);

      res.json({
        recommendations: riResult.recommendations || [],
        totalOnDemandMonthly: riResult.summary?.totalOnDemandMonthly || 0,
        totalReservedMonthly: riResult.summary?.totalReservedMonthly || 0,
        totalSavingMonthly: riResult.summary?.totalSavingMonthly || 0,
        totalSavingAnnual: riResult.summary?.totalSavingAnnual || 0,
        eligibleCount: riResult.summary?.eligibleCount || riResult.recommendations?.length || 0,
        skippedCount: riResult.summary?.skippedCount || 0,
      });

    } catch (error: any) {
      console.error('❌ Reserved instance analysis failed:', error);
      res.status(500).json({ error: 'Reserved instance analysis failed', details: error.message });
    }
  });

  // ─── FinOps: Budget Alert Generator ─────────────────────────────────────────
  // POST /api/valuation/budget-alerts
  // Creates a real Azure Budget Alert via the Cost Management REST API.
  app.post("/api/valuation/budget-alerts", requireAuth, validateRequest({ body: budgetAlertsBody }), async (req: any, res) => {
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

      // Audit log
      try {
        const authReq = req as AuthenticatedRequest;
        if (authReq.userId) {
          await storage.createUserActivity({
            userId: authReq.userId,
            sessionId: sessionId || null,
            module: 'valuation',
            actionType: 'valuation_budget_create',
            actionLabel: `Created budget alert: $${budget}/month with ${(thresholds as number[]).length} thresholds`,
            metadata: { budgetName, amount: budget, thresholds, emailCount: emailList.length },
          });
        }
      } catch (_auditErr) { /* audit failure should not break endpoint */ }

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
  app.post("/api/valuation/multicloud-compare", optionalAuth, aiMediumLimiter, validateRequest({ body: multicloudCompareBody }), async (req, res) => {
    try {
      const { resources } = req.body;

      if (!resources || !Array.isArray(resources)) {
        return res.status(400).json({ error: 'Resources array is required' });
      }

      console.log(`\n🌍 ========== VALUATION: MULTI-CLOUD COMPARE ==========`);
      console.log(`   Comparing ${resources.length} resource(s) across Azure / AWS / GCP`);

      const resourceSummary = resources
        .filter((r: any) => r.monthlyCost > 0)
        .map((r: any) => ({
          name: r.name,
          azureType: r.azureType || r.type,
          sku: r.currentSku,
          region: r.location,
          monthlyCost: r.monthlyCost,
          currency: r.currency || 'INR',
        }));

      const mcCompletion = await aiChatCompletion({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        max_tokens: 6000,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a multi-cloud pricing expert. For each Azure resource, identify the closest equivalent service and SKU on AWS and GCP, and estimate the monthly cost based on current public pricing. Use real pricing knowledge for the specific SKU and region — do not use generic ratios. Return JSON:
{
  "lineItems": [
    {
      "resourceName": "string",
      "role": "string (e.g. 'Web Server', 'Database')",
      "azureSku": "string",
      "azureMonthly": number,
      "awsEquivalent": "specific AWS service and instance type",
      "awsMonthly": number,
      "gcpEquivalent": "specific GCP service and machine type",
      "gcpMonthly": number
    }
  ],
  "totals": { "azure": number, "aws": number, "gcp": number },
  "annualTotals": { "azure": number, "aws": number, "gcp": number },
  "cheapestProvider": "azure" | "aws" | "gcp",
  "savingVsAzure": { "aws": number, "gcp": number },
  "insights": ["array of 3-5 specific, actionable insights about the cost comparison"],
  "resourceCount": number
}`
          },
          {
            role: 'user',
            content: `Compare these ${resourceSummary.length} Azure resources across AWS and GCP:\n${JSON.stringify(resourceSummary, null, 2)}`
          }
        ]
      });

      const mcContent = mcCompletion.choices[0]?.message?.content;
      if (!mcContent) {
        return res.status(500).json({ error: 'AI returned empty response for multi-cloud comparison' });
      }

      const mcResult = JSON.parse(mcContent) as {
        lineItems: any[];
        totals: { azure: number; aws: number; gcp: number };
        annualTotals: { azure: number; aws: number; gcp: number };
        cheapestProvider: string;
        savingVsAzure: { aws: number; gcp: number };
        insights: string[];
        resourceCount: number;
      };

      console.log(`   ✅ ${mcResult.lineItems?.length || 0} resource(s) compared`);
      console.log(`   🏆 Cheapest: ${mcResult.cheapestProvider}`);

      res.json({
        lineItems: mcResult.lineItems || [],
        totals: mcResult.totals || { azure: 0, aws: 0, gcp: 0 },
        annualTotals: mcResult.annualTotals || { azure: 0, aws: 0, gcp: 0 },
        cheapestProvider: mcResult.cheapestProvider || 'azure',
        savingVsAzure: mcResult.savingVsAzure || { aws: 0, gcp: 0 },
        insights: mcResult.insights || [],
        resourceCount: mcResult.resourceCount || mcResult.lineItems?.length || 0,
      });

    } catch (error: any) {
      console.error('❌ Multi-cloud comparison failed:', error);
      res.status(500).json({ error: 'Multi-cloud comparison failed', details: error.message });
    }
  });
}
