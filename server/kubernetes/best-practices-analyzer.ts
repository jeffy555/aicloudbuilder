import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export interface BestPracticeIssue {
  category: string;
  issue: string;
  suggestion: string;
  priority: 'high' | 'medium' | 'low';
  file?: string;
  line?: number;
}

export interface BestPracticeResult {
  success: boolean;
  issues: BestPracticeIssue[];
  summary: string;
}

/**
 * Analyze Kubernetes YAML for best practices using AI
 */
export async function analyzeKubernetesBestPractices(
  yamlContent: string | string[]
): Promise<BestPracticeResult> {
  console.log('\n🤖 Analyzing Kubernetes manifests for best practices...');

  const yamlFiles = Array.isArray(yamlContent) ? yamlContent : [yamlContent];
  const combinedYaml = yamlFiles.join('\n---\n');

  const systemPrompt = `You are an expert Kubernetes engineer. Your task is to analyze Kubernetes YAML manifests and identify best practice violations.

Analyze the provided Kubernetes manifests and identify:
1. **Resource Management**: Missing resource limits/requests, improper resource allocation
2. **High Availability**: Missing replicas, pod disruption budgets, anti-affinity rules
3. **Security**: Missing security contexts, running as root, improper RBAC, network policies
4. **Observability**: Missing probes (liveness/readiness), logging, metrics
5. **Configuration**: Improper ConfigMap/Secret usage, hardcoded values
6. **Networking**: Improper service types, missing ingress, network policies
7. **Storage**: Missing volume mounts, improper storage classes
8. **Labels and Selectors**: Missing or inconsistent labels

For each issue found, provide:
- Category (Resource Management, Security, etc.)
- Issue description
- Specific suggestion for fixing
- Priority (high, medium, low)

Return a JSON object with this structure:
{
  "issues": [
    {
      "category": "Resource Management",
      "issue": "Missing resource limits",
      "suggestion": "Add resources.requests and resources.limits to prevent resource exhaustion",
      "priority": "high",
      "file": "deployment.yaml",
      "line": 15
    }
  ]
}`;

  const userPrompt = `Analyze the following Kubernetes manifests for best practice violations:

\`\`\`yaml
${combinedYaml}
\`\`\`

Identify all best practice issues and provide specific, actionable suggestions.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: 'json_object' }
    });

    const responseText = completion.choices[0]?.message?.content || '{}';
    let analysis: any;

    try {
      analysis = JSON.parse(responseText);
    } catch (parseError) {
      console.error('❌ Failed to parse AI response:', parseError);
      throw new Error('Failed to parse AI analysis response');
    }

    const issues: BestPracticeIssue[] = analysis.issues || [];

    console.log(`✅ Best practices analysis complete: ${issues.length} issue(s) found`);

    const summary = `Found ${issues.length} best practice issue(s) across ${issues.filter((i: BestPracticeIssue) => i.priority === 'high').length} high priority, ${issues.filter((i: BestPracticeIssue) => i.priority === 'medium').length} medium priority, and ${issues.filter((i: BestPracticeIssue) => i.priority === 'low').length} low priority`;

    return {
      success: true,
      issues,
      summary,
    };
  } catch (error: any) {
    console.error('❌ Best practices analysis failed:', error);
    throw new Error(`Failed to analyze best practices: ${error.message || 'Unknown error'}`);
  }
}



