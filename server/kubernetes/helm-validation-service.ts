import { lintHelmChart, renderHelmChart } from './helm-validator';
import { validateKubernetesYAML } from './kubeval-validator';
import { runCheckovKubernetes } from './checkov-validator';
import { analyzeKubernetesBestPractices } from './best-practices-analyzer';
import { deepAnalyzeHelmChart, type DeepAnalysisResult } from './helm-deep-analyzer';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file: string;
  line?: number;
  suggestion?: string;
  source: 'helm-lint' | 'kubeval' | 'checkov' | 'best-practices';
}

export interface ValidationResult {
  success: boolean;
  issues: ValidationIssue[];
  lintResults?: {
    helmLint: {
      status: 'passed' | 'failed' | 'warning';
      warnings: number;
      errors: number;
    };
    kubeval: {
      status: 'passed' | 'failed';
      errors: number;
    };
    checkov: {
      passed: number;
      failed: number;
      skipped: number;
    };
  };
  bestPractices?: Array<{
    category: string;
    issue: string;
    suggestion: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  deepAnalysis?: DeepAnalysisResult;
  summary: {
    totalIssues: number;
    errors: number;
    warnings: number;
    info: number;
  };
}

export interface ValidationOptions {
  runHelmLint?: boolean;
  runKubeval?: boolean;
  runCheckov?: boolean;
  runBestPractices?: boolean;
  runDeepAnalysis?: boolean;
  helmFiles?: Array<{ path: string; content: string }>; // raw source files for deep analysis
}

/**
 * Validate a Helm chart with all configured validators
 */
export async function validateHelmChart(
  chartPath: string,
  options: ValidationOptions = {}
): Promise<ValidationResult> {
  const {
    runHelmLint = true,
    runKubeval = true,
    runCheckov = true,
    runBestPractices = true,
    runDeepAnalysis = true,
    helmFiles = [],
  } = options;

  console.log('\n🔍 ========== HELM CHART VALIDATION ==========');
  console.log(`Chart Path: ${chartPath}`);
  console.log(`Options:`, options);

  const issues: ValidationIssue[] = [];
  const lintResults: any = {};

  try {
    // 1. Helm Lint
    if (runHelmLint) {
      console.log('\n📋 Running Helm lint...');
      const helmLintResult = await lintHelmChart(chartPath);
      
      lintResults.helmLint = {
        status: helmLintResult.status,
        warnings: helmLintResult.warnings.length,
        errors: helmLintResult.errors.length,
      };

      // Add issues from Helm lint
      helmLintResult.errors.forEach(err => {
        issues.push({
          severity: 'error',
          message: err.message,
          file: err.file || chartPath,
          line: err.line,
          source: 'helm-lint',
        });
      });

      helmLintResult.warnings.forEach(warn => {
        issues.push({
          severity: 'warning',
          message: warn.message,
          file: warn.file || chartPath,
          line: warn.line,
          source: 'helm-lint',
        });
      });
    }

    // 2. Render chart and validate with Kubeval, Checkov, and Deep Analysis
    let renderedTemplates: string[] = [];
    if (runKubeval || runCheckov || runBestPractices || runDeepAnalysis) {
      console.log('\n📦 Rendering Helm chart templates...');
      renderedTemplates = await renderHelmChart(chartPath).catch(() => []);

      // 3. Kubeval
      if (runKubeval && renderedTemplates.length > 0) {
        console.log('\n🔍 Running Kubeval...');
        const kubevalResult = await validateKubernetesYAML(renderedTemplates);
        
        lintResults.kubeval = {
          status: kubevalResult.valid ? 'passed' : 'failed',
          errors: kubevalResult.errors.length,
        };

        kubevalResult.errors.forEach(err => {
          issues.push({
            severity: 'error',
            message: err.message,
            file: err.file || 'rendered-template',
            line: err.line,
            source: 'kubeval',
          });
        });
      }

      // 4. Checkov
      if (runCheckov && renderedTemplates.length > 0) {
        console.log('\n🔒 Running Checkov...');
        const yamlFiles = renderedTemplates.map((content, index) => ({
          path: `template-${index}.yaml`,
          content,
        }));
        const checkovResult = await runCheckovKubernetes(yamlFiles);
        
        lintResults.checkov = {
          passed: checkovResult.passed,
          failed: checkovResult.failed,
          skipped: checkovResult.skipped,
        };

        checkovResult.checks.forEach(check => {
          const severity = check.severity === 'CRITICAL' || check.severity === 'HIGH' 
            ? 'error' 
            : check.severity === 'MEDIUM' 
            ? 'warning' 
            : 'info';

          issues.push({
            severity,
            message: check.message,
            file: check.file,
            suggestion: check.guideline,
            source: 'checkov',
          });
        });
      }

      // 5. Best Practices (AI) — only run when deep analysis is disabled
      if (runBestPractices && !runDeepAnalysis && renderedTemplates.length > 0) {
        console.log('\n🤖 Running AI best practices analysis...');
        const bestPracticesResult = await analyzeKubernetesBestPractices(renderedTemplates);

        bestPracticesResult.issues.forEach(issue => {
          issues.push({
            severity: issue.priority === 'high' ? 'error' : issue.priority === 'medium' ? 'warning' : 'info',
            message: issue.issue,
            file: issue.file || 'rendered-template',
            line: issue.line,
            suggestion: issue.suggestion,
            source: 'best-practices',
          });
        });
      }
    }

    // 6. Deep Analysis — multi-pass specialist AI scoring
    let deepAnalysis: DeepAnalysisResult | undefined;
    if (runDeepAnalysis) {
      console.log('\n🔬 Running deep multi-pass analysis...');
      try {
        deepAnalysis = await deepAnalyzeHelmChart(helmFiles, renderedTemplates);

        // Surface critical/high deep issues into the main issues list too
        deepAnalysis.issues
          .filter(i => i.severity === 'critical' || i.severity === 'high')
          .forEach(i => {
            issues.push({
              severity: i.severity === 'critical' ? 'error' : 'warning',
              message: `[${i.category.toUpperCase()}] ${i.title}: ${i.description}`,
              file: i.file || 'helm-chart',
              suggestion: i.fixSnippet,
              source: 'best-practices',
            });
          });
      } catch (deepErr: any) {
        console.warn(`   ⚠️  Deep analysis failed (non-fatal): ${deepErr.message}`);
      }
    }

    // Calculate summary
    const errors = issues.filter(i => i.severity === 'error').length;
    const warnings = issues.filter(i => i.severity === 'warning').length;
    const info = issues.filter(i => i.severity === 'info').length;

    const result: ValidationResult = {
      success: errors === 0,
      issues,
      lintResults: Object.keys(lintResults).length > 0 ? lintResults : undefined,
      bestPractices: issues
        .filter(i => i.source === 'best-practices')
        .map(i => ({
          category: 'Best Practices',
          issue: i.message,
          suggestion: i.suggestion || '',
          priority: i.severity === 'error' ? 'high' : i.severity === 'warning' ? 'medium' : 'low',
        })),
      deepAnalysis,
      summary: {
        totalIssues: issues.length,
        errors,
        warnings,
        info,
      },
    };

    console.log(`\n✅ Validation complete!`);
    console.log(`   Total Issues: ${result.summary.totalIssues}`);
    console.log(`   Errors: ${result.summary.errors}`);
    console.log(`   Warnings: ${result.summary.warnings}`);
    console.log('==========================================\n');

    return result;
  } catch (error: any) {
    console.error('❌ Helm chart validation failed:', error);
    throw new Error(`Failed to validate Helm chart: ${error.message || 'Unknown error'}`);
  }
}



