/**
 * Compliance Presets for ArchMe
 *
 * AI-driven compliance requirement generation using GPT-4o-mini.
 * Framework names are real standards; specific requirements are generated
 * dynamically based on the user's architecture description.
 */

import { aiChatCompletion } from '../utils/ai-client.js';
import { sanitizeContent } from '../utils/sanitize-prompt.js';

export interface CompliancePreset {
  id: string;
  name: string;
  shortName: string;
  description: string;
  requiredComponents: string[];
  forbiddenPatterns: string[];
  additionalRequirements: string[];
  regionConstraints?: string[];
}

/** Static catalog of compliance frameworks — names and descriptions only. */
const COMPLIANCE_FRAMEWORKS: Omit<CompliancePreset, 'requiredComponents' | 'forbiddenPatterns' | 'additionalRequirements' | 'regionConstraints'>[] = [
  {
    id: 'hipaa',
    name: 'HIPAA',
    shortName: 'HIPAA',
    description: 'Health Insurance Portability and Accountability Act — protects patient health information',
  },
  {
    id: 'soc2',
    name: 'SOC 2 Type II',
    shortName: 'SOC2',
    description: 'Service Organization Control 2 — trust service criteria for security, availability, and confidentiality',
  },
  {
    id: 'pci-dss',
    name: 'PCI DSS v4.0',
    shortName: 'PCI-DSS',
    description: 'Payment Card Industry Data Security Standard — protects cardholder data',
  },
  {
    id: 'gdpr',
    name: 'GDPR',
    shortName: 'GDPR',
    description: 'General Data Protection Regulation — EU data privacy and protection',
  },
  {
    id: 'iso27001',
    name: 'ISO 27001',
    shortName: 'ISO 27001',
    description: 'International standard for information security management systems (ISMS)',
  },
  {
    id: 'fedramp',
    name: 'FedRAMP (Moderate)',
    shortName: 'FedRAMP',
    description: 'Federal Risk and Authorization Management Program — US government cloud security',
  },
];

/**
 * Get all available compliance presets (metadata only — no AI call).
 */
export function getCompliancePresets(): CompliancePreset[] {
  return COMPLIANCE_FRAMEWORKS.map(f => ({
    ...f,
    requiredComponents: [],
    forbiddenPatterns: [],
    additionalRequirements: [],
  }));
}

/**
 * Get a specific compliance preset by ID (metadata only — no AI call).
 */
export function getCompliancePreset(id: string): CompliancePreset | undefined {
  const framework = COMPLIANCE_FRAMEWORKS.find(f => f.id === id);
  if (!framework) return undefined;
  return {
    ...framework,
    requiredComponents: [],
    forbiddenPatterns: [],
    additionalRequirements: [],
  };
}

/**
 * Use AI to generate context-specific compliance requirements for the given
 * frameworks, then format them as a prompt section to inject into the
 * architecture analyzer's system prompt.
 */
export async function buildCompliancePromptSection(
  presetIds: string[],
  architectureDescription?: string,
): Promise<string> {
  const frameworks = presetIds
    .map(id => COMPLIANCE_FRAMEWORKS.find(f => f.id === id))
    .filter((f): f is typeof COMPLIANCE_FRAMEWORKS[number] => f !== undefined);

  if (frameworks.length === 0) return '';

  const frameworkNames = frameworks.map(f => f.name).join(', ');

  try {
    const response = await aiChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system' as const,
          content: `You are a cloud compliance expert specializing in ${frameworkNames}. Given this architecture description, generate specific compliance requirements that are relevant to the described components. For each requirement, provide: rule description, implementation guidance specific to the cloud services mentioned, and priority (critical/high/medium). Only include requirements that are actually relevant to the architecture — do not include generic rules that don't apply.

Return JSON: { "requirements": [{ "rule": "<requirement description>", "guidance": "<implementation guidance>", "priority": "critical" | "high" | "medium", "applicableComponents": ["<component name>"] }] }`,
        },
        {
          role: 'user' as const,
          content: `Generate compliance requirements for frameworks: ${frameworkNames}.${architectureDescription ? `\n\nArchitecture description:\n${sanitizeContent(architectureDescription)}` : '\n\nGenerate requirements applicable to a general cloud architecture.'}`,
        },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty AI response');

    const parsed = JSON.parse(content) as {
      requirements: {
        rule: string;
        guidance: string;
        priority: string;
        applicableComponents: string[];
      }[];
    };

    // Format into the prompt section that gets injected into the analyzer
    const sections: string[] = [];
    for (const fw of frameworks) {
      const fwRequirements = parsed.requirements ?? [];
      const lines: string[] = [];
      lines.push(`\n### ${fw.name} Compliance Requirements:`);

      const critical = fwRequirements.filter(r => r.priority === 'critical');
      const high = fwRequirements.filter(r => r.priority === 'high');
      const medium = fwRequirements.filter(r => r.priority === 'medium');

      if (critical.length > 0) {
        lines.push('\nCritical requirements:');
        for (const r of critical) {
          lines.push(`  - ${r.rule}`);
          lines.push(`    Guidance: ${r.guidance}`);
          if (r.applicableComponents?.length) {
            lines.push(`    Applies to: ${r.applicableComponents.join(', ')}`);
          }
        }
      }
      if (high.length > 0) {
        lines.push('\nHigh-priority requirements:');
        for (const r of high) {
          lines.push(`  - ${r.rule}`);
          lines.push(`    Guidance: ${r.guidance}`);
        }
      }
      if (medium.length > 0) {
        lines.push('\nMedium-priority requirements:');
        for (const r of medium) {
          lines.push(`  - ${r.rule}`);
          lines.push(`    Guidance: ${r.guidance}`);
        }
      }

      sections.push(lines.join('\n'));
    }

    return `

COMPLIANCE REQUIREMENTS (MANDATORY — architecture MUST satisfy these):
${sections.join('\n')}

When analyzing the architecture:
1. Ensure ALL required security components are present as explicit components (add them if missing from the user's requirements)
2. Flag any forbidden patterns by adding a relationship of type "compliance-violation" between offending components
3. Add security boundaries that match the compliance isolation requirements
4. Set metadata.codeType appropriately to ensure compliance components get proper IaC generation
5. In the response, include a "complianceNotes" array with objects: { "preset": "<preset_id>", "status": "compliant" | "warning" | "non-compliant", "details": "<explanation>" }
`;
  } catch {
    // Safe default on AI failure — generic compliance note per framework
    const fallbackNotes = frameworks
      .map(fw => `  - Ensure ${fw.name} compliance requirements are met for all components.`)
      .join('\n');

    return `

COMPLIANCE REQUIREMENTS (MANDATORY — architecture MUST satisfy these):
${fallbackNotes}

When analyzing the architecture:
1. Ensure ALL required security components are present as explicit components (add them if missing from the user's requirements)
2. Flag any forbidden patterns by adding a relationship of type "compliance-violation" between offending components
3. Add security boundaries that match the compliance isolation requirements
4. Set metadata.codeType appropriately to ensure compliance components get proper IaC generation
5. In the response, include a "complianceNotes" array with objects: { "preset": "<preset_id>", "status": "compliant" | "warning" | "non-compliant", "details": "<explanation>" }
`;
  }
}
