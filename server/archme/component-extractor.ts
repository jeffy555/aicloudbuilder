/**
 * Component Extractor for ArchMe
 * 
 * Extracts components from architecture diagram/analysis for code generation
 */

import type { ArchitectureAnalysis, ArchitectureComponent } from '../diagram/architecture-analyzer';

export interface ExtractedComponent {
  name: string;
  type: string;
  provider: 'azure' | 'aws' | 'gcp' | 'third-party' | 'unknown';
  category: string;
  description: string;
  dependencies: string[]; // Names of components this depends on
  codeType: 'terraform' | 'arm' | 'helm' | 'yaml' | 'kubernetes'; // Preferred code type
  metadata?: {
    serviceType?: string;
    originalName?: string;
  };
}

/**
 * Extract components from architecture analysis
 */
export function extractComponents(analysis: ArchitectureAnalysis): ExtractedComponent[] {
  console.log('\n🔍 ========== COMPONENT EXTRACTION ==========');
  console.log(`📊 Extracting from ${analysis.components.length} components`);
  
  const extracted: ExtractedComponent[] = [];
  
  // Build dependency map from relationships
  const dependencyMap = new Map<string, string[]>();
  analysis.relationships.forEach(rel => {
    // If A depends on B, add B to A's dependencies
    if (!dependencyMap.has(rel.from)) {
      dependencyMap.set(rel.from, []);
    }
    dependencyMap.get(rel.from)!.push(rel.to);
  });
  
  // Extract each component
  analysis.components.forEach(component => {
    const dependencies = dependencyMap.get(component.name) || [];

    // Primary: use the codeType the AI determined from the requirements.
    // Fallback: minimal structural inference only when the AI omits the field.
    let codeType: ExtractedComponent['codeType'];

    if (component.metadata?.codeType) {
      codeType = component.metadata.codeType;
    } else {
      // Fallback inference — no hardcoded tool lists, only structural signals
      const nameLower = component.name.toLowerCase();
      const typeLower = component.type.toLowerCase();

      if (typeLower.includes('kubernetes') ||
          nameLower.includes('aks') || nameLower.includes('eks') || nameLower.includes('gke') ||
          nameLower.includes('kubernetes')) {
        codeType = 'kubernetes';
      } else if (nameLower.includes('helm') || nameLower.includes('chart')) {
        codeType = 'helm';
      } else if (component.metadata?.deploymentContext === 'in-cluster') {
        codeType = 'yaml';
      } else {
        codeType = 'terraform';
      }
    }
    
    const extractedComponent: ExtractedComponent = {
      name: component.name,
      type: component.type,
      provider: component.cloudProvider === 'multi' ? 'unknown' : component.cloudProvider,
      category: component.category,
      description: component.description,
      dependencies,
      codeType,
      metadata: {
        serviceType: component.metadata?.serviceType,
        originalName: component.originalName
      }
    };
    
    extracted.push(extractedComponent);
    console.log(`   ✅ Extracted: ${component.name} (${component.cloudProvider}, ${codeType})`);
  });
  
  console.log(`\n✅ Extracted ${extracted.length} components`);
  return extracted;
}

