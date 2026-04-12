/**
 * Azure Cost Management Integration
 * Fetches actual costs from Azure Cost Management API
 */

/**
 * Get actual costs from Azure Cost Management for specific resources.
 * Retries on 429/503 with exponential backoff.
 */
export async function fetchActualCosts(
  accessToken: string,
  subscriptionId: string,
  startDate: string,
  endDate: string,
  maxRetries: number = 3
): Promise<Map<string, number>> {
  const apiUrl = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-03-01`;

  const requestBody = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: {
      from: startDate,
      to: endDate
    },
    dataset: {
      granularity: 'None',
      aggregation: {
        totalCost: {
          name: 'Cost',
          function: 'Sum'
        }
      },
      grouping: [
        {
          type: 'Dimension',
          name: 'ResourceId'
        }
      ]
    }
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (response.status === 429 || response.status === 503) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '0', 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(`   ⚠️  Cost Management API returned ${response.status}, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Cost Management API failed: ${response.status} ${error}`);
      }

      const data = await response.json();
      const costMap = new Map<string, number>();

      // Parse the response
      if (data.properties && data.properties.rows) {
        for (const row of data.properties.rows) {
          const cost = row[0]; // Total cost
          const resourceId = row[1]; // Resource ID
          if (resourceId) {
            costMap.set(resourceId.toLowerCase(), cost);
          }
        }
      }

      console.log(`   💰 Fetched actual costs for ${costMap.size} resources from Azure Cost Management`);
      return costMap;

    } catch (error: any) {
      if (attempt === maxRetries) {
        console.error(`   ⚠️  Could not fetch actual costs after ${maxRetries} attempts: ${error.message}`);
        return new Map();
      }
      const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
      console.warn(`   ⚠️  Cost Management fetch failed (attempt ${attempt}/${maxRetries}): ${error.message}, retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return new Map();
}

/**
 * Get month-to-date period
 */
export function getMonthToDatePeriod(): { startDate: string; endDate: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return {
    startDate: `${year}-${month}-01`,
    endDate: `${year}-${month}-${day}`
  };
}

/**
 * Get last month period
 */
export function getLastMonthPeriod(): { startDate: string; endDate: string } {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const year = lastMonth.getFullYear();
  const month = String(lastMonth.getMonth() + 1).padStart(2, '0');

  // Last day of last month
  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();

  return {
    startDate: `${year}-${month}-01`,
    endDate: `${year}-${month}-${String(lastDay).padStart(2, '0')}`
  };
}
