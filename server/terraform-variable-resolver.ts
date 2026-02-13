/**
 * Terraform Variable Resolver
 *
 * Resolves variable references (var.xxx) in Terraform resource blocks by looking up
 * values from multiple sources in priority order:
 *   1. terraform.tfvars
 *   2. variables.tf defaults
 *   3. Literal values in main.tf
 *
 * Tracks which variables remain unresolved for "needs_input" classification.
 */

export interface TerraformFile {
  fileName: string;
  content: string;
}

export interface ResolvedVariables {
  /** Successfully resolved variable name -> value */
  resolved: Record<string, string>;
  /** Variable names that could not be resolved */
  unresolved: string[];
}

/**
 * Parse terraform.tfvars for variable assignments.
 * Handles: string, number, bool, and simple list/map values.
 */
function parseTfvars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};

  // Match: variable_name = "value" or variable_name = value
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || !trimmed.includes('=')) continue;

    // Simple key = "value" or key = value
    const match = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"$/);
    if (match) {
      vars[match[1]] = match[2];
      continue;
    }

    // key = number or key = bool
    const simpleMatch = trimmed.match(/^(\w+)\s*=\s*([^\s#]+)/);
    if (simpleMatch) {
      vars[simpleMatch[1]] = simpleMatch[2];
    }
  }

  // Also handle multi-line lists: var_name = ["a", "b", "c"]
  const listRegex = /(\w+)\s*=\s*\[([^\]]+)\]/g;
  let listMatch;
  while ((listMatch = listRegex.exec(content)) !== null) {
    const varName = listMatch[1];
    const items = listMatch[2].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    vars[varName] = JSON.stringify(items);
    // Also store the count for for_each resolution
    vars[`__count_${varName}`] = String(items.length);
  }

  // Handle multi-line maps: var_name = { key = "value" ... }
  const mapRegex = /(\w+)\s*=\s*\{([^}]+)\}/g;
  let mapMatch;
  while ((mapMatch = mapRegex.exec(content)) !== null) {
    const varName = mapMatch[1];
    const mapBody = mapMatch[2];
    const entries = mapBody.split('\n')
      .map(l => l.trim())
      .filter(l => l.includes('='));
    vars[`__count_${varName}`] = String(entries.length);
    vars[varName] = mapBody.trim();
  }

  return vars;
}

/**
 * Parse variables.tf for variable declarations with defaults.
 * Handles: variable "name" { default = "value" }
 */
function parseVariableDefaults(content: string): Record<string, string> {
  const vars: Record<string, string> = {};

  // Match variable blocks with defaults
  const varBlockRegex = /variable\s+"(\w+)"\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
  let blockMatch;

  while ((blockMatch = varBlockRegex.exec(content)) !== null) {
    const varName = blockMatch[1];
    const body = blockMatch[2];

    // Look for default = "value"
    const defaultStr = body.match(/default\s*=\s*"([^"]*)"/);
    if (defaultStr) {
      vars[varName] = defaultStr[1];
      continue;
    }

    // Look for default = number/bool
    const defaultSimple = body.match(/default\s*=\s*([^\s\n#]+)/);
    if (defaultSimple) {
      const val = defaultSimple[1].trim();
      if (val !== '{' && val !== '[') {
        vars[varName] = val;
      }
    }

    // Look for default = ["a", "b"]
    const defaultList = body.match(/default\s*=\s*\[([^\]]+)\]/);
    if (defaultList) {
      const items = defaultList[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      vars[varName] = JSON.stringify(items);
      vars[`__count_${varName}`] = String(items.length);
    }
  }

  return vars;
}

/**
 * Build a complete variable resolution map from all Terraform files.
 * Priority: tfvars > variables.tf defaults
 */
export function buildVariableMap(files: TerraformFile[]): Record<string, string> {
  const tfvarsValues: Record<string, string> = {};
  const defaultValues: Record<string, string> = {};

  for (const file of files) {
    const name = file.fileName.toLowerCase();
    if (name.endsWith('.tfvars')) {
      Object.assign(tfvarsValues, parseTfvars(file.content));
    } else if (name === 'variables.tf' || name.includes('variables')) {
      Object.assign(defaultValues, parseVariableDefaults(file.content));
    }
  }

  // Merge: tfvars override defaults
  return { ...defaultValues, ...tfvarsValues };
}

/**
 * Resolve a single value that may contain a var.xxx reference.
 * Returns the resolved value and whether it was resolved.
 */
export function resolveValue(
  value: string,
  variableMap: Record<string, string>
): { value: string; resolved: boolean } {
  if (!value.startsWith('var.')) {
    return { value, resolved: true };
  }

  const varName = value.replace('var.', '');
  if (varName in variableMap) {
    return { value: variableMap[varName], resolved: true };
  }

  return { value, resolved: false };
}

/**
 * Resolve all var.xxx references in a resource's attributes.
 * Returns resolved attributes and list of unresolved variable names.
 */
export function resolveResourceAttributes(
  attributes: Record<string, any>,
  variableMap: Record<string, string>
): { attrs: Record<string, any>; unresolved: string[] } {
  const resolved: Record<string, any> = {};
  const unresolved: string[] = [];

  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' && value.startsWith('var.')) {
      const varName = value.replace('var.', '');
      if (varName in variableMap) {
        resolved[key] = variableMap[varName];
      } else {
        resolved[key] = value; // Keep the reference
        unresolved.push(varName);
      }
    } else {
      resolved[key] = value;
    }
  }

  return { attrs: resolved, unresolved };
}

/**
 * Resolve a location value, handling var.xxx and resource references.
 */
export function resolveLocation(
  rawLocation: string,
  variableMap: Record<string, string>,
  defaultLocation: string = 'eastus'
): { location: string; resolved: boolean } {
  if (!rawLocation) return { location: defaultLocation, resolved: false };

  // Handle var.xxx
  if (rawLocation.startsWith('var.')) {
    const { value, resolved } = resolveValue(rawLocation, variableMap);
    if (resolved) return { location: value, resolved: true };
    return { location: defaultLocation, resolved: false };
  }

  // Handle resource references (e.g., azurerm_resource_group.main.location)
  if (rawLocation.includes('.')) {
    return { location: defaultLocation, resolved: false };
  }

  return { location: rawLocation, resolved: true };
}

/**
 * Resolve count/for_each from variable references.
 */
export function resolveResourceCount(
  body: string,
  variableMap: Record<string, string>
): { count: number; resolved: boolean } {
  // Check for count
  const countMatch = body.match(/count\s*=\s*([^\s\n}]+)/);
  if (countMatch) {
    const val = countMatch[1].trim().replace(/^["']|["']$/g, '');
    const num = parseInt(val, 10);
    if (!isNaN(num)) return { count: num, resolved: true };

    if (val.startsWith('var.')) {
      const varName = val.replace('var.', '');
      if (varName in variableMap) {
        const resolved = parseInt(variableMap[varName], 10);
        if (!isNaN(resolved)) return { count: resolved, resolved: true };
      }
      return { count: 1, resolved: false };
    }
  }

  // Check for for_each
  const forEachMatch = body.match(/for_each\s*=\s*([^\n]+)/);
  if (forEachMatch) {
    const val = forEachMatch[1].trim();

    // Inline set: toset(["a", "b", "c"])
    const inlineSet = val.match(/toset\(\[([^\]]+)\]\)/);
    if (inlineSet) {
      const items = inlineSet[1].split(',');
      return { count: items.length, resolved: true };
    }

    // Variable reference: var.xxx or toset(var.xxx)
    const varRef = val.match(/(?:toset\()?var\.(\w+)\)?/);
    if (varRef) {
      const varName = varRef[1];
      const countKey = `__count_${varName}`;
      if (countKey in variableMap) {
        return { count: parseInt(variableMap[countKey], 10), resolved: true };
      }
      if (varName in variableMap) {
        try {
          const parsed = JSON.parse(variableMap[varName]);
          if (Array.isArray(parsed)) return { count: parsed.length, resolved: true };
        } catch {
          // Not a JSON array
        }
      }
      return { count: 1, resolved: false };
    }
  }

  return { count: 1, resolved: true };
}
