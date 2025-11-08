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
  const subdirectories: Set<string> = new Set();
  const rootFiles: string[] = [];

  for (const file of files) {
    if (!file.path.endsWith('.tf')) continue;

    const content = file.content;

    // Track directory structure
    // Check if file is in a subdirectory (e.g., ResourceGroup/main.tf, StorageAccount/variables.tf)
    const pathParts = file.path.split('/');
    if (pathParts.length > 1) {
      // File is in a subdirectory
      subdirectories.add(pathParts[0]);
    } else {
      // File is in root directory
      rootFiles.push(file.path);
    }

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

  // Determine module type based on directory structure and content
  let moduleType: 'child' | 'root' | 'empty' = 'empty';
  
  if (files.length === 0) {
    moduleType = 'empty';
  } else if (subdirectories.size > 0 && rootFiles.length === 0) {
    // Directory structure with separate folders for each resource/module (e.g., ResourceGroup/, StorageAccount/)
    // This represents a child module structure
    moduleType = 'child';
  } else if (rootFiles.length > 0 && subdirectories.size === 0) {
    // Files directly in root directory without modular folder structure
    if (hasModules) {
      // Has module blocks referencing other modules - aggregated root module
      moduleType = 'root';
    } else if (hasResources) {
      // Has resource blocks only - standalone root module
      moduleType = 'root';
    }
  } else if (subdirectories.size > 0 && rootFiles.length > 0) {
    // Mixed structure - has both root files and subdirectories
    // If root files contain module blocks, it's an aggregated root
    // Otherwise, it's ambiguous - default to root
    moduleType = hasModules ? 'root' : 'root';
  }

  return {
    cloudProvider,
    moduleType,
    hasResources,
    hasModules,
    providerBlocks: Array.from(providerBlocks),
  };
}
