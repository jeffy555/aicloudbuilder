export interface BackendConfiguration {
  hasBackend: boolean;
  backendType: 'azurerm' | 'aws' | 'gcs' | null;
  storageAccountName?: string;
  resourceGroupName?: string;
  containerName?: string;
  stateFileKey?: string;
}

export interface TerraformAnalysis {
  cloudProvider: 'azure' | 'aws' | 'gcp' | null;
  moduleType: 'child' | 'root' | 'empty';
  hasResources: boolean;
  hasModules: boolean;
  providerBlocks: string[];
  backend: BackendConfiguration;
}

function parseBackendConfiguration(files: { path: string; content: string }[]): BackendConfiguration {
  const backend: BackendConfiguration = {
    hasBackend: false,
    backendType: null,
  };

  for (const file of files) {
    if (!file.path.endsWith('.tf')) continue;

    const content = file.content;

    // Check for terraform backend block
    const backendMatch = content.match(/terraform\s*\{[\s\S]*?backend\s+"([^"]+)"\s*\{([\s\S]*?)\}/m);
    if (backendMatch) {
      backend.hasBackend = true;
      const backendTypeRaw = backendMatch[1];
      const backendBody = backendMatch[2];

      if (backendTypeRaw === 'azurerm') {
        backend.backendType = 'azurerm';
        
        // Extract Azure backend parameters
        const storageAccountMatch = backendBody.match(/storage_account_name\s*=\s*"([^"]+)"/);
        const resourceGroupMatch = backendBody.match(/resource_group_name\s*=\s*"([^"]+)"/);
        const containerMatch = backendBody.match(/container_name\s*=\s*"([^"]+)"/);
        const keyMatch = backendBody.match(/key\s*=\s*"([^"]+)"/);

        if (storageAccountMatch) backend.storageAccountName = storageAccountMatch[1];
        if (resourceGroupMatch) backend.resourceGroupName = resourceGroupMatch[1];
        if (containerMatch) backend.containerName = containerMatch[1];
        if (keyMatch) backend.stateFileKey = keyMatch[1];
      } else if (backendTypeRaw === 's3') {
        backend.backendType = 'aws';
      } else if (backendTypeRaw === 'gcs') {
        backend.backendType = 'gcs';
      }
      
      break; // Found backend, no need to continue
    }
  }

  return backend;
}

export function analyzeTerraformFiles(files: { path: string; content: string }[]): TerraformAnalysis {
  let cloudProvider: 'azure' | 'aws' | 'gcp' | null = null;
  let hasResources = false;
  let hasModules = false;
  const providerBlocks: Set<string> = new Set();
  const subdirectories: Set<string> = new Set();
  const rootFiles: string[] = [];
  const resourceTypes: Set<string> = new Set();

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

    // Detect cloud provider from provider blocks
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

    // Detect cloud provider from resource types (if not already detected from provider blocks)
    // Match: resource "azurerm_storage_account" "name" { ... }
    const resourceTypeMatches = content.match(/resource\s+"([^"]+)"\s+"[^"]+"/g);
    if (resourceTypeMatches) {
      resourceTypeMatches.forEach(match => {
        const resourceType = match.match(/resource\s+"([^"]+)"/)?.[1];
        if (resourceType) {
          resourceTypes.add(resourceType);
          
          // If cloud provider not yet detected, detect from resource type prefix
          if (!cloudProvider) {
            if (resourceType.startsWith('azurerm_') || 
                resourceType.startsWith('azuread_') || 
                resourceType.startsWith('azapi_') ||
                resourceType.startsWith('azurestack_')) {
              cloudProvider = 'azure';
            } else if (resourceType.startsWith('aws_')) {
              cloudProvider = 'aws';
            } else if (resourceType.startsWith('google_') || 
                       resourceType.startsWith('google_compute_') ||
                       resourceType.startsWith('google_storage_') ||
                       resourceType.startsWith('google_container_')) {
              cloudProvider = 'gcp';
            }
          }
        }
      });
    }

    // Also check for data sources
    const dataSourceMatches = content.match(/data\s+"([^"]+)"\s+"[^"]+"/g);
    if (dataSourceMatches) {
      dataSourceMatches.forEach(match => {
        const dataSourceType = match.match(/data\s+"([^"]+)"/)?.[1];
        if (dataSourceType && !cloudProvider) {
          if (dataSourceType.startsWith('azurerm_') || 
              dataSourceType.startsWith('azuread_') || 
              dataSourceType.startsWith('azapi_')) {
            cloudProvider = 'azure';
          } else if (dataSourceType.startsWith('aws_')) {
            cloudProvider = 'aws';
          } else if (dataSourceType.startsWith('google_')) {
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

  // Parse backend configuration
  const backend = parseBackendConfiguration(files);

  return {
    cloudProvider,
    moduleType,
    hasResources,
    hasModules,
    providerBlocks: Array.from(providerBlocks),
    backend,
  };
}
