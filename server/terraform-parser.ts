export interface TerraformAnalysis {
  cloudProvider: 'azure' | 'aws' | 'gcp' | null;
  moduleType: 'child' | 'root' | 'empty';
  hasResources: boolean;
  hasModules: boolean;
  providerBlocks: string[];
}

export function analyzeTerraformFiles(files: { path: string; content: string }[]): TerraformAnalysis {
  let cloudProvider: 'azure' | 'aws' | 'gcp' | null = null;
  let hasResources = false;
  let hasModules = false;
  const providerBlocks: Set<string> = new Set();

  for (const file of files) {
    if (!file.path.endsWith('.tf')) continue;

    const content = file.content;

    const providerMatches = content.match(/provider\s+"([^"]+)"/g);
    if (providerMatches) {
      providerMatches.forEach(match => {
        const provider = match.match(/provider\s+"([^"]+)"/)?.[1];
        if (provider) {
          providerBlocks.add(provider);
          
          if (provider === 'azurerm' || provider === 'azuread' || provider === 'azapi') {
            cloudProvider = 'azure';
          } else if (provider === 'aws') {
            cloudProvider = 'aws';
          } else if (provider === 'google') {
            cloudProvider = 'gcp';
          }
        }
      });
    }

    const resourceMatches = content.match(/resource\s+"[^"]+"\s+"[^"]+"/g);
    if (resourceMatches && resourceMatches.length > 0) {
      hasResources = true;
    }

    const moduleMatches = content.match(/module\s+"[^"]+"/g);
    if (moduleMatches && moduleMatches.length > 0) {
      hasModules = true;
    }
  }

  let moduleType: 'child' | 'root' | 'empty' = 'empty';
  if (hasResources || hasModules) {
    if (hasModules) {
      moduleType = 'root';
    } else if (hasResources) {
      moduleType = 'child';
    }
  }

  return {
    cloudProvider,
    moduleType,
    hasResources,
    hasModules,
    providerBlocks: Array.from(providerBlocks),
  };
}
