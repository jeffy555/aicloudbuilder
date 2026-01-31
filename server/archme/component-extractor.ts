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
    
    // Determine code type based on component type and provider
    let codeType: ExtractedComponent['codeType'] = 'terraform';
    
    if (component.type.toLowerCase().includes('kubernetes') || 
        component.name.toLowerCase().includes('aks') ||
        component.name.toLowerCase().includes('eks') ||
        component.name.toLowerCase().includes('gke')) {
      codeType = 'kubernetes';
    } else if (component.name.toLowerCase().includes('helm') ||
               component.name.toLowerCase().includes('chart')) {
      codeType = 'helm';
    } else if (component.cloudProvider === 'azure' && 
               (component.type.toLowerCase().includes('arm') || 
                component.category.toLowerCase().includes('template'))) {
      codeType = 'arm';
    } else if (component.isThirdParty && 
               (component.name.toLowerCase().includes('prometheus') ||
                component.name.toLowerCase().includes('grafana') ||
                component.name.toLowerCase().includes('istio') ||
                component.name.toLowerCase().includes('argocd'))) {
      codeType = 'yaml';
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

