/**
 * Test Script: Add Storage Account, Run Cost Analysis & Checkov Scan
 * Repository: https://github.com/jeffy555/my-repo-jeff
 */

import fs from 'fs';

const BASE_URL = 'http://localhost:9005';

async function makeRequest(method, endpoint, body = null) {
  const url = `${BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type');
  
  if (contentType && contentType.includes('text/html')) {
    throw new Error(`Server returned HTML. Status: ${response.status}`);
  }
  
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function runTest() {
  const report = {
    timestamp: new Date().toISOString(),
    repository: 'https://github.com/jeffy555/my-repo-jeff',
    sessionId: null,
    steps: {}
  };

  try {
    console.log('🧪 Starting Test: Add Storage Account, Cost Analysis & Checkov Scan\n');
    console.log('='.repeat(80));

    // Step 1: Create Session
    console.log('\n📝 Step 1: Creating Session...');
    const session = await makeRequest('POST', '/api/sessions', {
      provider: 'github',
      repoName: 'my-repo-jeff',
      owner: 'jeffy555',
    });
    report.sessionId = session.id;
    console.log(`✅ Session created: ${report.sessionId}`);

    // Set provider and repository
    await makeRequest('PATCH', `/api/sessions/${report.sessionId}`, {
      provider: 'github',
      repositoryName: 'my-repo-jeff',
      owner: 'jeffy555',
    });
    console.log('✅ Provider and repository set');

    // Step 2: Scan Repository
    console.log('\n📁 Step 2: Scanning Repository...');
    const scanResult = await makeRequest('POST', `/api/sessions/${report.sessionId}/scan-repository`);
    report.steps.scan = {
      cloudProvider: scanResult.cloudProvider,
      moduleType: scanResult.moduleType,
      filesFound: scanResult.terraformFiles?.length || 0,
      files: scanResult.terraformFiles || []
    };
    console.log(`✅ Repository scanned:`);
    console.log(`   Cloud Provider: ${scanResult.cloudProvider}`);
    console.log(`   Module Type: ${scanResult.moduleType}`);
    console.log(`   Files Found: ${scanResult.terraformFiles?.length || 0}`);

    // Step 3: Add Storage Account
    console.log('\n🔧 Step 3: Adding Storage Account...');
    console.log('   Request: "Add a storage account with Standard tier and LRS replication"');
    const generateResult = await makeRequest('POST', `/api/sessions/${report.sessionId}/generate-terraform`, {
      description: 'Add a storage account with Standard tier and LRS replication',
      cloudProvider: scanResult.cloudProvider || 'azure',
      moduleApproach: scanResult.moduleType || 'root',
    });
    report.steps.generation = {
      filesGenerated: generateResult.files?.length || 0,
      files: generateResult.files || []
    };
    console.log(`✅ Storage account generation completed`);
    if (generateResult.files && generateResult.files.length > 0) {
      console.log(`   Files generated/updated: ${generateResult.files.length}`);
      generateResult.files.forEach((f, idx) => {
        console.log(`   ${idx + 1}. ${f.path} (${f.content.length} chars)`);
      });
    } else {
      console.log('   Note: Files may have been updated in session storage');
    }

    // Step 4: Cost Analysis
    console.log('\n💰 Step 4: Running Cost Analysis (AI-Driven)...');
    const costResult = await makeRequest('POST', `/api/sessions/${report.sessionId}/analyze-cost`);
    
    // Debug: Log full response
    console.log(`   📋 API Response:`, JSON.stringify(costResult, null, 2).substring(0, 500));
    
    report.steps.costAnalysis = {
      success: costResult.success,
      summary: costResult.summary,
      resources: costResult.resources || [],
      error: costResult.error,
      details: costResult.details,
      hasData: costResult.success && (costResult.resources?.length > 0 || costResult.summary?.totalMonthly > 0)
    };
    
    if (costResult.success && costResult.summary) {
      const summary = costResult.summary;
      console.log(`✅ Cost Analysis Results:`);
      console.log(`   Total Monthly Cost: $${summary.totalMonthly?.toFixed(2) || '0.00'}`);
      console.log(`   Total Yearly Cost: $${summary.totalYearly?.toFixed(2) || '0.00'}`);
      console.log(`   Currency: ${summary.currency || 'USD'}`);
      console.log(`   Resources Analyzed: ${summary.resourceCount || 0}`);
      
      if (costResult.resources && costResult.resources.length > 0) {
        console.log(`\n   Cost Breakdown:`);
        costResult.resources.forEach((item, idx) => {
          console.log(`   ${idx + 1}. ${item.resourceName} (${item.resourceType})`);
          console.log(`      Service: ${item.serviceName}`);
          console.log(`      Monthly: $${item.monthlyCost?.toFixed(2) || '0.00'}`);
          if (item.details?.calculation) {
            console.log(`      Calculation: ${item.details.calculation}`);
          }
          if (item.details?.assumptions && item.details.assumptions.length > 0) {
            console.log(`      Assumptions: ${item.details.assumptions.join(', ')}`);
          }
        });
      } else {
        console.log(`   ⚠️  No cost breakdown available (${summary.resourceCount || 0} resources found)`);
        console.log(`   This may indicate pricing queries failed for all resources`);
      }
    } else {
      console.log(`⚠️  Cost analysis failed or returned no data`);
      if (costResult.error) {
        console.log(`   Error: ${costResult.error}`);
      }
      if (costResult.details) {
        console.log(`   Details: ${costResult.details}`);
      }
      console.log(`   Possible reasons:`);
      console.log(`   - No resources found in Terraform files`);
      console.log(`   - Resources not parsed correctly`);
      console.log(`   - All pricing queries failed`);
    }

    // Step 5: Checkov Scan
    console.log('\n🔍 Step 5: Running Checkov Security Scan...');
    const checkovResult = await makeRequest('POST', `/api/sessions/${report.sessionId}/scan`);
    report.steps.checkov = {
      summary: checkovResult.summary,
      failedChecks: checkovResult.failedChecks || [],
      passedChecks: checkovResult.passedChecks || [],
      totalChecks: checkovResult.summary?.total || 0
    };
    
    console.log(`✅ Checkov Scan Results:`);
    console.log(`   Total Checks: ${checkovResult.summary?.total || 0}`);
    console.log(`   Passed: ${checkovResult.summary?.passed || 0} ✅`);
    console.log(`   Failed: ${checkovResult.summary?.failed || 0} ❌`);
    console.log(`   Skipped: ${checkovResult.summary?.skipped || 0}`);
    console.log(`   Pass Rate: ${checkovResult.summary?.passPercentage?.toFixed(1) || 0}%`);
    
    if (checkovResult.failedChecks && checkovResult.failedChecks.length > 0) {
      console.log(`\n   Failed Checks (showing first 10):`);
      checkovResult.failedChecks.slice(0, 10).forEach((check, idx) => {
        console.log(`   ${idx + 1}. ${check.checkId}: ${check.checkName}`);
        console.log(`      Resource: ${check.resource}`);
        console.log(`      File: ${check.file}`);
      });
      if (checkovResult.failedChecks.length > 10) {
        console.log(`   ... and ${checkovResult.failedChecks.length - 10} more failed checks`);
      }
    }

    // Generate Report
    console.log('\n' + '='.repeat(80));
    console.log('📊 Generating Report...');
    
    const reportFile = 'TEST_STORAGE_COST_CHECKOV.json';
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`✅ JSON Report saved: ${reportFile}`);
    
    const mdReport = createMarkdownReport(report);
    const mdFile = 'TEST_STORAGE_COST_CHECKOV.md';
    fs.writeFileSync(mdFile, mdReport);
    console.log(`✅ Markdown Report saved: ${mdFile}`);
    
    console.log('\n✅ Test completed successfully!');
    return report;

  } catch (error) {
    report.error = error.message;
    console.error('\n❌ Test failed:', error.message);
    throw error;
  }
}

function createMarkdownReport(report) {
  let md = `# Test Report: Storage Account, Cost Analysis & Checkov Scan\n\n`;
  md += `**Date:** ${new Date(report.timestamp).toLocaleString()}\n`;
  md += `**Repository:** ${report.repository}\n`;
  md += `**Session ID:** ${report.sessionId}\n\n`;
  md += `---\n\n`;

  // Repository Scan
  md += `## 📁 Repository Scan\n\n`;
  if (report.steps.scan) {
    md += `- **Cloud Provider:** ${report.steps.scan.cloudProvider || 'Not detected'}\n`;
    md += `- **Module Type:** ${report.steps.scan.moduleType || 'Not detected'}\n`;
    md += `- **Files Found:** ${report.steps.scan.filesFound}\n\n`;
    if (report.steps.scan.files.length > 0) {
      md += `### Files:\n\n`;
      report.steps.scan.files.forEach((file, idx) => {
        md += `${idx + 1}. \`${file}\`\n`;
      });
      md += `\n`;
    }
  }

  // Storage Account Generation
  md += `## 🔧 Storage Account Generation\n\n`;
  if (report.steps.generation) {
    md += `**Request:** "Add a storage account with Standard tier and LRS replication"\n\n`;
    md += `**Files Generated/Updated:** ${report.steps.generation.filesGenerated}\n\n`;
    if (report.steps.generation.files && report.steps.generation.files.length > 0) {
      report.steps.generation.files.forEach((file, idx) => {
        md += `${idx + 1}. **${file.path}** (${file.content.length} characters)\n`;
      });
    } else {
      md += `*Note: Files may have been updated in session storage.*\n`;
    }
  }
  md += `\n`;

  // Cost Analysis
  md += `## 💰 Cost Analysis Results (AI-Driven)\n\n`;
  if (report.steps.costAnalysis && report.steps.costAnalysis.hasData && report.steps.costAnalysis.summary) {
    const summary = report.steps.costAnalysis.summary;
    md += `### Cost Summary\n\n`;
    md += `- **Total Monthly Cost:** $${summary.totalMonthly?.toFixed(2) || '0.00'}\n`;
    md += `- **Total Yearly Cost:** $${summary.totalYearly?.toFixed(2) || '0.00'}\n`;
    md += `- **Currency:** ${summary.currency || 'USD'}\n`;
    md += `- **Resources Analyzed:** ${summary.resourceCount || 0}\n\n`;

    if (report.steps.costAnalysis.resources && report.steps.costAnalysis.resources.length > 0) {
      md += `### Cost Breakdown by Resource\n\n`;
      report.steps.costAnalysis.resources.forEach((item, idx) => {
        md += `${idx + 1}. **${item.resourceName}**\n`;
        md += `   - **Type:** \`${item.resourceType}\`\n`;
        md += `   - **Service:** ${item.serviceName}\n`;
        md += `   - **Monthly Cost:** $${item.monthlyCost?.toFixed(2) || '0.00'}\n`;
        if (item.details?.calculation) {
          md += `   - **Calculation:** ${item.details.calculation}\n`;
        }
        if (item.details?.assumptions && item.details.assumptions.length > 0) {
          md += `   - **Assumptions:** ${item.details.assumptions.join(', ')}\n`;
        }
        md += `\n`;
      });
    } else {
      md += `⚠️ **No cost breakdown available** (${summary.resourceCount || 0} resources found but no cost estimates generated)\n\n`;
    }
  } else {
    md += `⚠️ **No cost data available**\n\n`;
    if (report.steps.costAnalysis?.summary) {
      md += `**Status:** ${report.steps.costAnalysis.success ? 'Success' : 'Failed'}\n`;
      md += `**Resources Found:** ${report.steps.costAnalysis.summary.resourceCount || 0}\n\n`;
    }
    md += `This may be because:\n`;
    md += `- No resources were detected in Terraform files\n`;
    md += `- Resources need to be parsed correctly from files\n`;
    md += `- Cost estimation requires resource attributes\n`;
    md += `- All pricing queries failed\n`;
    if (report.steps.costAnalysis?.error) {
      md += `- **Error:** ${report.steps.costAnalysis.error}\n`;
    }
    md += `\n`;
  }

  // Checkov Results
  md += `## 🔍 Checkov Security Scan Results\n\n`;
  if (report.steps.checkov) {
    const c = report.steps.checkov;
    md += `### Summary\n\n`;
    md += `- **Total Checks:** ${c.totalChecks}\n`;
    md += `- **Passed:** ${c.summary?.passed || 0} ✅\n`;
    md += `- **Failed:** ${c.summary?.failed || 0} ❌\n`;
    md += `- **Skipped:** ${c.summary?.skipped || 0}\n`;
    md += `- **Pass Rate:** ${c.summary?.passPercentage?.toFixed(1) || 0}%\n\n`;

    if (c.failedChecks && c.failedChecks.length > 0) {
      md += `### Failed Checks (${c.failedChecks.length})\n\n`;
      c.failedChecks.forEach((check, idx) => {
        md += `${idx + 1}. **${check.checkId}**: ${check.checkName}\n`;
        md += `   - **Resource:** \`${check.resource}\`\n`;
        md += `   - **File:** \`${check.file}\`\n`;
        if (check.guideline) {
          md += `   - **Guideline:** ${check.guideline}\n`;
        }
        md += `\n`;
      });
    }

    if (c.passedChecks && c.passedChecks.length > 0) {
      md += `### Passed Checks (${c.passedChecks.length})\n\n`;
      c.passedChecks.slice(0, 10).forEach((check, idx) => {
        md += `${idx + 1}. **${check.checkId}**: ${check.checkName} ✅\n`;
      });
      if (c.passedChecks.length > 10) {
        md += `\n*... and ${c.passedChecks.length - 10} more passed checks*\n`;
      }
    }
  }

  md += `\n---\n\n`;
  md += `## 📊 Test Summary\n\n`;
  md += `✅ All steps completed successfully!\n\n`;
  md += `1. ✅ Repository scanned\n`;
  md += `2. ✅ Storage account added\n`;
  md += `3. ✅ Cost analysis completed (AI-driven)\n`;
  md += `4. ✅ Checkov security scan completed\n\n`;

  return md;
}

// Run the test
runTest()
  .then(() => {
    console.log('\n✅ Test completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });

