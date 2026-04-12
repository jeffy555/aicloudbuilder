/**
 * Topological Sort for ArchMe Component Dependencies
 *
 * Sorts generated code files by dependency order using Kahn's algorithm.
 * Ensures providers.tf → variables.tf → resources → outputs.tf → README.md
 */

import type { GeneratedCode } from './code-generator';

/**
 * Sort files by dependency order (topological sort).
 * Files with no dependencies come first; dependents come after their deps.
 * Falls back to priority-based ordering for Terraform structure files.
 */
export function sortByDependencyOrder(files: GeneratedCode[]): GeneratedCode[] {
  /** File generation priority — lower numbers are generated/displayed first.
   *  Follows Terraform convention: providers -> variables -> main resources -> outputs -> docs */
  const filePriority: Record<string, number> = {
    'providers.tf': 0,   // Must be first — declares required providers
    'variables.tf': 1,   // Second — defines input variables used by resources
    'main.tf': 2,        // Third — contains the actual resource definitions
    'outputs.tf': 90,    // Near-last — references resources that must exist first
    'README.md': 99,     // Last — documentation generated after all code
    'readme.md': 99,     // Last — case variant
  };

  // Build adjacency list from dependencies
  const nameToFile = new Map<string, GeneratedCode>();
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const file of files) {
    nameToFile.set(file.componentName, file);
    inDegree.set(file.componentName, 0);
    adjacency.set(file.componentName, []);
  }

  // Build edges: if A depends on B, B must come before A
  for (const file of files) {
    for (const dep of file.dependencies) {
      if (nameToFile.has(dep)) {
        adjacency.get(dep)!.push(file.componentName);
        inDegree.set(file.componentName, (inDegree.get(file.componentName) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, degree] of Array.from(inDegree.entries())) {
    if (degree === 0) queue.push(name);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    // Among candidates with 0 in-degree, prefer by file priority
    queue.sort((a, b) => {
      const fileA = nameToFile.get(a)!;
      const fileB = nameToFile.get(b)!;
      const prioA = filePriority[fileA.fileName] ?? 50;
      const prioB = filePriority[fileB.fileName] ?? 50;
      return prioA - prioB;
    });

    const current = queue.shift()!;
    sorted.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Handle cycles: any remaining files not in sorted list get appended
  const sortedSet = new Set(sorted);
  for (const file of files) {
    if (!sortedSet.has(file.componentName)) {
      sorted.push(file.componentName);
    }
  }

  return sorted.map(name => nameToFile.get(name)!).filter(Boolean);
}
