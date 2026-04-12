import yaml from 'js-yaml';
import { aiChatCompletion } from '../utils/ai-client.js';
import { convertToDiagramType, DiagramType } from '../diagram/diagram-type-generator';

export interface KubernetesResource {
  kind: string;
  name: string;
  namespace?: string;
  file: string;
  // Label selector fields for accurate relationship extraction
  podTemplateLabels?: Record<string, string>;  // spec.template.metadata.labels
  selectorLabels?: Record<string, string>;      // spec.selector or spec.selector.matchLabels
}

export interface KubernetesRelationship {
  from: string;
  to: string;
  type: string;
  description?: string;
}

export interface DiagramResult {
  success: boolean;
  mermaidSyntax: string;
  resources: KubernetesResource[];
  relationships: KubernetesRelationship[];
  metadata: {
    totalResources: number;
    totalRelationships: number;
    resourceTypes: string[];
  };
}

function cleanYamlScalar(value: string): string {
  return value
    .replace(/\s+#.*$/, "")
    .trim()
    .replace(/^['"]|['"]$/g, "");
}

function normalizeResourceName(rawName: string | undefined, fallback: string): string {
  if (!rawName) return fallback;
  let normalized = cleanYamlScalar(rawName);
  if (normalized.includes("{{")) {
    normalized = normalized.replace(/\{\{[\s\S]*?\}\}/g, "tmpl");
  }
  normalized = normalized
    .replace(/[^a-zA-Z0-9-_.]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function extractTemplateResource(manifest: string, index: number): KubernetesResource | null {
  const kindMatch = manifest.match(/^\s*kind:\s*([A-Za-z0-9]+)/m);
  if (!kindMatch) return null;

  const kind = kindMatch[1];
  const kindFallback = `${kind.toLowerCase()}-${index}`;

  const lines = manifest.split(/\r?\n/);
  let inMetadata = false;
  let metadataIndent = -1;
  let nameRaw: string | undefined;
  let namespaceRaw: string | undefined;

  for (const line of lines) {
    const indent = (line.match(/^\s*/) || [""])[0].length;
    const trimmed = line.trim();

    if (!inMetadata && /^metadata:\s*$/.test(trimmed)) {
      inMetadata = true;
      metadataIndent = indent;
      continue;
    }

    if (inMetadata) {
      if (trimmed.length === 0) continue;
      if (indent <= metadataIndent && !trimmed.startsWith("#")) {
        break;
      }
      const nameMatch = line.match(/^\s*name:\s*(.+)\s*$/);
      if (nameMatch && !nameRaw) {
        nameRaw = nameMatch[1];
      }
      const nsMatch = line.match(/^\s*namespace:\s*(.+)\s*$/);
      if (nsMatch && !namespaceRaw) {
        namespaceRaw = nsMatch[1];
      }
    }
  }

  return {
    kind,
    name: normalizeResourceName(nameRaw, kindFallback),
    namespace: normalizeResourceName(namespaceRaw, "default"),
    file: `resource-${index}.yaml`,
    selectorLabels: {},
    podTemplateLabels: {},
  };
}

function findResourceByKind(
  resources: KubernetesResource[],
  kind: string,
  preferredName?: string
): KubernetesResource | undefined {
  if (preferredName) {
    const exact = resources.find((r) => r.kind === kind && r.name === preferredName);
    if (exact) return exact;
  }
  return resources.find((r) => r.kind === kind);
}

function extractTemplateRelationships(
  manifest: string,
  currentResource: KubernetesResource,
  resources: KubernetesResource[]
): KubernetesRelationship[] {
  const rels: KubernetesRelationship[] = [];
  const kind = currentResource.kind;

  // Deployment-like workload -> Pod(s)
  if (kind === "Deployment") {
    const replicasMatch = manifest.match(/^\s*replicas:\s*(\d+)\s*$/m);
    const replicaCount = replicasMatch ? Math.max(1, Number(replicasMatch[1])) : 1;
    for (let i = 1; i <= Math.min(replicaCount, 3); i++) {
      rels.push({
        from: `${currentResource.kind}:${currentResource.name}`,
        to: `Pod:${currentResource.name}-pod-${i}`,
        type: "manages",
        description: `Manages ${replicaCount} pod(s)`,
      });
    }
  }

  // Service -> first known workload (best-effort for templated selectors/includes)
  if (kind === "Service") {
    const workload =
      findResourceByKind(resources, "Deployment")
      || findResourceByKind(resources, "StatefulSet")
      || findResourceByKind(resources, "DaemonSet")
      || findResourceByKind(resources, "Pod");
    if (workload) {
      rels.push({
        from: `${currentResource.kind}:${currentResource.name}`,
        to: `${workload.kind}:${workload.name}`,
        type: "exposes",
        description: "Exposes workload (templated selector)",
      });
    }
  }

  // HPA -> scale target
  if (kind === "HorizontalPodAutoscaler") {
    const refKindMatch = manifest.match(/scaleTargetRef:\s*[\s\S]*?^\s*kind:\s*([A-Za-z0-9]+)\s*$/m);
    const refNameMatch = manifest.match(/scaleTargetRef:\s*[\s\S]*?^\s*name:\s*(.+)\s*$/m);
    const refKind = refKindMatch?.[1];
    const refName = refNameMatch ? normalizeResourceName(refNameMatch[1], "tmpl") : undefined;
    const target =
      (refKind ? findResourceByKind(resources, refKind, refName) : undefined)
      || findResourceByKind(resources, "Deployment");
    if (target) {
      rels.push({
        from: `${currentResource.kind}:${currentResource.name}`,
        to: `${target.kind}:${target.name}`,
        type: "scales",
        description: "Autoscales workload",
      });
    }
  }

  // Ingress -> Service
  if (kind === "Ingress") {
    const svcNameMatch = manifest.match(/backend:\s*[\s\S]*?service:\s*[\s\S]*?^\s*name:\s*(.+)\s*$/m);
    const preferredServiceName = svcNameMatch
      ? normalizeResourceName(svcNameMatch[1], "tmpl")
      : undefined;
    const service = findResourceByKind(resources, "Service", preferredServiceName);
    if (service) {
      rels.push({
        from: `${currentResource.kind}:${currentResource.name}`,
        to: `${service.kind}:${service.name}`,
        type: "routes-to",
        description: "Routes traffic to service",
      });
    }
  }

  return rels;
}

/**
 * Parse Kubernetes YAML to extract resources
 */
function parseKubernetesResources(manifests: string[]): KubernetesResource[] {
  const resources: KubernetesResource[] = [];

  manifests.forEach((manifest, index) => {
    try {
      const parsed = yaml.load(manifest) as any;
      if (parsed && parsed.kind && parsed.metadata) {
        // Capture selector labels for workloads (Deployment, StatefulSet, DaemonSet, etc.)
        const selectorRaw = parsed.spec?.selector;
        const selectorLabels: Record<string, string> =
          selectorRaw?.matchLabels ?? (typeof selectorRaw === 'object' && !selectorRaw?.matchExpressions ? selectorRaw : {}) ?? {};

        // Pod template labels for workloads
        const podTemplateLabels: Record<string, string> =
          parsed.spec?.template?.metadata?.labels ?? {};

        resources.push({
          kind: parsed.kind,
          name: parsed.metadata.name || `${parsed.kind.toLowerCase()}-${index}`,
          namespace: parsed.metadata.namespace || 'default',
          file: `resource-${index}.yaml`,
          selectorLabels,
          podTemplateLabels,
        });
      }
    } catch (error) {
      const templated = extractTemplateResource(manifest, index);
      if (templated) {
        resources.push(templated);
        console.log(`ℹ️  Parsed templated resource fallback: ${templated.kind}/${templated.name}`);
      } else {
        console.warn(`⚠️  Failed to parse manifest ${index}:`, error);
      }
    }
  });

  return resources;
}

/**
 * Extract relationships from Kubernetes resources
 */
function extractRelationships(
  manifests: string[],
  resources: KubernetesResource[]
): KubernetesRelationship[] {
  const relationships: KubernetesRelationship[] = [];
  const resourceMap = new Map<string, KubernetesResource>();
  resources.forEach(r => {
    resourceMap.set(`${r.kind}:${r.name}`, r);
  });

  manifests.forEach((manifest, index) => {
    try {
      const parsed = yaml.load(manifest) as any;
      if (!parsed || !parsed.kind || !parsed.metadata) return;

      const currentResource =
        resourceMap.get(`${parsed.kind}:${parsed.metadata.name}`) || {
          kind: parsed.kind,
          name: parsed.metadata.name,
          namespace: parsed.metadata.namespace || "default",
          file: `resource-${index}.yaml`,
          selectorLabels: {},
          podTemplateLabels: {},
        };

      // Deployment -> Pods (via replicas)
      if (parsed.kind === 'Deployment' && parsed.spec?.replicas) {
        const replicaCount = parsed.spec.replicas;
        for (let i = 1; i <= Math.min(replicaCount, 3); i++) {
          relationships.push({
            from: `${currentResource.kind}:${currentResource.name}`,
            to: `Pod:${currentResource.name}-pod-${i}`,
            type: 'manages',
            description: `Manages ${replicaCount} pod(s)`,
          });
        }
      }

      // Service -> Workload (via label selectors — real K8s matching)
      if (parsed.kind === 'Service' && parsed.spec?.selector) {
        const svcSelector: Record<string, string> = parsed.spec.selector;
        if (Object.keys(svcSelector).length > 0) {
          const workloadKinds = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Pod']);
          resources.forEach(resource => {
            if (!workloadKinds.has(resource.kind)) return;
            // Match against pod template labels (for workloads) or resource labels
            const targetLabels = resource.podTemplateLabels && Object.keys(resource.podTemplateLabels).length > 0
              ? resource.podTemplateLabels
              : resource.selectorLabels ?? {};
            const matches = Object.entries(svcSelector).every(([k, v]) => targetLabels[k] === v);
            if (matches) {
              relationships.push({
                from: `${currentResource.kind}:${currentResource.name}`,
                to: `${resource.kind}:${resource.name}`,
                type: 'exposes',
                description: 'Exposes via label selector',
              });
            }
          });
        }
      }

      // Pod -> ConfigMap/Secret (via volume mounts)
      if (parsed.kind === 'Pod' && parsed.spec?.volumes) {
        parsed.spec.volumes.forEach((volume: any) => {
          if (volume.configMap) {
            const configMapName = volume.configMap.name;
            const configMap = resources.find(r => r.kind === 'ConfigMap' && r.name === configMapName);
            if (configMap) {
              relationships.push({
                from: `${currentResource.kind}:${currentResource.name}`,
                to: `${configMap.kind}:${configMap.name}`,
                type: 'uses',
                description: 'Mounts ConfigMap',
              });
            }
          }
          if (volume.secret) {
            const secretName = volume.secret.secretName;
            const secret = resources.find(r => r.kind === 'Secret' && r.name === secretName);
            if (secret) {
              relationships.push({
                from: `${currentResource.kind}:${currentResource.name}`,
                to: `${secret.kind}:${secret.name}`,
                type: 'uses',
                description: 'Mounts Secret',
              });
            }
          }
        });
      }

      // HPA -> Workload (via scaleTargetRef)
      if (parsed.kind === 'HorizontalPodAutoscaler' && parsed.spec?.scaleTargetRef) {
        const ref = parsed.spec.scaleTargetRef;
        const target = resources.find(r => r.kind === ref.kind && r.name === ref.name);
        if (target) {
          relationships.push({
            from: `${currentResource.kind}:${currentResource.name}`,
            to: `${target.kind}:${target.name}`,
            type: 'scales',
            description: 'Autoscales workload',
          });
        }
      }

      // Ingress -> Service (same namespace + cross-namespace via annotations)
      if (parsed.kind === 'Ingress' && parsed.spec?.rules) {
        // Determine target namespace: annotation overrides, then metadata.namespace, then 'default'
        const ingressNs: string = parsed.metadata?.namespace || 'default';
        parsed.spec.rules.forEach((rule: any) => {
          if (rule.http?.paths) {
            rule.http.paths.forEach((path: any) => {
              const serviceName: string | undefined = path.backend?.service?.name;
              if (!serviceName) return;
              // Target namespace from annotation (nginx: nginx.ingress.kubernetes.io/service-namespace)
              const targetNs: string =
                parsed.metadata?.annotations?.['nginx.ingress.kubernetes.io/service-namespace'] ||
                path.backend?.service?.namespace ||
                ingressNs;

              const service = resources.find(r =>
                r.kind === 'Service' &&
                r.name === serviceName &&
                (r.namespace === targetNs || r.namespace === ingressNs || targetNs === 'default')
              );
              if (service) {
                const crossNs = service.namespace !== ingressNs;
                relationships.push({
                  from: `${currentResource.kind}:${currentResource.name}`,
                  to: `${service.kind}:${service.name}`,
                  type: 'routes-to',
                  description: crossNs
                    ? `Cross-ns route → ${service.namespace}`
                    : 'Routes traffic to service',
                });
              }
            });
          }
        });
      }

      // NetworkPolicy namespaceSelector → cross-namespace relationship annotation
      if (parsed.kind === 'NetworkPolicy' && parsed.spec?.ingress) {
        parsed.spec.ingress.forEach((rule: any) => {
          if (rule.from) {
            rule.from.forEach((peer: any) => {
              if (peer.namespaceSelector?.matchLabels) {
                const nsLabel = JSON.stringify(peer.namespaceSelector.matchLabels);
                relationships.push({
                  from: `${currentResource.kind}:${currentResource.name}`,
                  to: `NetworkPolicy:${currentResource.name}`,
                  type: 'allows-from-ns',
                  description: `Allows from namespaces: ${nsLabel}`,
                });
              }
            });
          }
        });
      }
    } catch (error) {
      const templateResource = resources[index] || extractTemplateResource(manifest, index);
      if (templateResource && manifest.includes("{{")) {
        const fallbackRels = extractTemplateRelationships(manifest, templateResource, resources);
        if (fallbackRels.length > 0) {
          relationships.push(...fallbackRels);
          console.log(
            `ℹ️  Extracted ${fallbackRels.length} templated relationship(s) for ${templateResource.kind}/${templateResource.name}`
          );
        } else {
          console.warn(`⚠️  No templated relationships inferred for manifest ${index}`);
        }
      } else {
        console.warn(`⚠️  Failed to extract relationships from manifest ${index}:`, error);
      }
    }
  });

  const dedupe = new Set<string>();
  return relationships.filter((rel) => {
    const key = `${rel.from}|${rel.to}|${rel.type}`;
    if (dedupe.has(key)) return false;
    dedupe.add(key);
    return true;
  });
}

/**
 * Sanitize namespace name for Mermaid (avoid reserved keywords)
 */
function sanitizeNamespaceId(namespace: string): string {
  // Replace non-alphanumeric with underscore
  let sanitized = namespace.replace(/[^a-zA-Z0-9]/g, '_');

  // Ensure it doesn't start with a number
  if (/^\d/.test(sanitized)) {
    sanitized = 'ns_' + sanitized;
  }

  // Prefix any ID that starts with a Mermaid v10+ reserved keyword (case-insensitive).
  // Exact match AND prefix match — e.g. "namespace-system" → "namespace_system" → still matches.
  const lower = sanitized.toLowerCase();
  if (MERMAID_RESERVED_NODE_PREFIXES.some(kw => lower.startsWith(kw.toLowerCase()))) {
    sanitized = 'ns_' + sanitized;
  }

  return sanitized;
}

// Mermaid v10+ reserved keywords — cannot appear at the START of any node ID (case-insensitive)
const MERMAID_RESERVED_NODE_PREFIXES = [
  'namespace', 'graph', 'subgraph', 'end', 'class', 'classDef',
  'style', 'linkStyle', 'click', 'default',
];

/**
 * Sanitize node ID for Mermaid (ensure valid identifier)
 */
function sanitizeNodeId(id: string): string {
  if (!id || typeof id !== 'string') {
    return 'node';
  }

  // Remove newlines, carriage returns, and other whitespace characters
  let sanitized = id.replace(/[\n\r\t\s]/g, '_');

  // Replace all non-alphanumeric with underscore
  sanitized = sanitized.replace(/[^a-zA-Z0-9_]/g, '_');

  // Remove leading/trailing underscores
  sanitized = sanitized.replace(/^_+|_+$/g, '');

  // Replace multiple consecutive underscores with single underscore
  sanitized = sanitized.replace(/_+/g, '_');

  // Ensure it doesn't start with a number
  if (/^\d/.test(sanitized)) {
    sanitized = 'node_' + sanitized;
  }

  // Ensure it's not empty
  if (!sanitized || sanitized.length === 0) {
    sanitized = 'node';
  }

  // Prefix any ID that starts with a Mermaid v10+ reserved keyword (case-insensitive).
  // e.g. "Namespace_prod" → "k8s_Namespace_prod" to avoid the tokenizer treating
  // "namespace" as a grammar keyword and failing to parse the class/node statement.
  const lower = sanitized.toLowerCase();
  if (MERMAID_RESERVED_NODE_PREFIXES.some(kw => lower.startsWith(kw.toLowerCase()))) {
    sanitized = 'k8s_' + sanitized;
  }

  // Limit length to avoid issues
  if (sanitized.length > 50) {
    sanitized = sanitized.substring(0, 50);
  }

  return sanitized;
}

/**
 * Map a Kubernetes kind (lowercase) to a Mermaid classDef name
 */
function getStyleClass(kindLower: string): string {
  if (kindLower === 'deployment') return 'deployment';
  if (kindLower === 'statefulset') return 'statefulset';
  if (kindLower === 'daemonset') return 'daemonset';
  if (kindLower === 'job') return 'job';
  if (kindLower === 'cronjob') return 'cronjob';
  if (kindLower === 'service') return 'service';
  if (kindLower === 'ingress') return 'ingress';
  if (kindLower === 'pod') return 'pod';
  if (kindLower === 'configmap') return 'configmap';
  if (kindLower === 'secret') return 'secret';
  if (kindLower === 'horizontalpodautoscaler') return 'hpa';
  if (kindLower === 'persistentvolumeclaim') return 'pvc';
  if (kindLower === 'persistentvolume') return 'pv';
  if (kindLower === 'namespace') return 'nsresource';
  if (kindLower === 'serviceaccount') return 'serviceaccount';
  if (kindLower === 'networkpolicy') return 'networkpolicy';
  if (kindLower === 'storageclass') return 'storageclass';
  return '';
}

/**
 * Generate Mermaid diagram syntax from Kubernetes resources
 */
function generateMermaidSyntax(
  resources: KubernetesResource[],
  relationships: KubernetesRelationship[]
): string {
  let syntax = 'graph TB\n';

  // Track all node IDs for consistency
  const allNodeIds = new Set<string>();
  
  // Group resources by namespace
  const resourcesByNamespace = new Map<string, KubernetesResource[]>();
  resources.forEach(r => {
    const ns = r.namespace || 'default';
    if (!resourcesByNamespace.has(ns)) {
      resourcesByNamespace.set(ns, []);
    }
    resourcesByNamespace.get(ns)!.push(r);
    // Track node ID
    const nodeId = sanitizeNodeId(`${r.kind}_${r.name}`);
    allNodeIds.add(nodeId);
  });

  // Create subgraphs for namespaces
  resourcesByNamespace.forEach((nsResources, namespace) => {
    const safeNamespaceId = sanitizeNamespaceId(namespace);
    syntax += `    subgraph ${safeNamespaceId}["Namespace: ${namespace}"]\n`;
    syntax += `        direction TB\n`;

    // Group by resource type
    const byKind = new Map<string, KubernetesResource[]>();
    nsResources.forEach(r => {
      if (!byKind.has(r.kind)) {
        byKind.set(r.kind, []);
      }
      byKind.get(r.kind)!.push(r);
    });

    // Add resources
    byKind.forEach((kindResources, kind) => {
      kindResources.forEach(resource => {
        const nodeId = sanitizeNodeId(`${resource.kind}_${resource.name}`);
        // Sanitize label to avoid issues with quotes and special characters
        const label = `${resource.kind}: ${resource.name}`.replace(/"/g, "'").replace(/\n/g, ' ');
        syntax += `        ${nodeId}["${label}"]\n`;
      });
    });

    syntax += `    end\n\n`;
  });

  // Add relationships (only for resources that exist)
  syntax += `    %% Relationships\n`;
  const existingNodeIds = new Set(allNodeIds);

  relationships.forEach(rel => {
    const fromParts = rel.from.split(':');
    const toParts = rel.to.split(':');
    const fromId = sanitizeNodeId(`${fromParts[0]}_${fromParts[1]}`);
    const toId = sanitizeNodeId(`${toParts[0]}_${toParts[1]}`);
    
    // Only add relationship if both nodes exist
    if (existingNodeIds.has(fromId) && existingNodeIds.has(toId)) {
      const label = (rel.description || rel.type).replace(/"/g, "'").replace(/\n/g, ' '); // Escape quotes and newlines in labels
      syntax += `    ${fromId} -->|"${label}"| ${toId}\n`;
    } else {
      // If target node doesn't exist, create it as a simple node first (outside subgraph)
      if (!existingNodeIds.has(toId) && toParts.length === 2) {
        const toLabel = `${toParts[0]}: ${toParts[1]}`.replace(/"/g, "'").replace(/\n/g, ' ');
        syntax += `    ${toId}["${toLabel}"]\n`;
        existingNodeIds.add(toId);
      }
      if (existingNodeIds.has(fromId) && existingNodeIds.has(toId)) {
        const label = (rel.description || rel.type).replace(/"/g, "'").replace(/\n/g, ' ');
        syntax += `    ${fromId} -->|"${label}"| ${toId}\n`;
      }
    }
  });

  // Add styling
  syntax += `\n    %% Styling\n`;
  syntax += `    classDef deployment fill:#4A90E2,stroke:#2E5C8A,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef service fill:#50C878,stroke:#2E7D4E,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef pod fill:#FFB84D,stroke:#CC8A3D,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef configmap fill:#9B59B6,stroke:#6C3483,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef secret fill:#E74C3C,stroke:#A93226,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef ingress fill:#3498DB,stroke:#21618C,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef statefulset fill:#8b5cf6,stroke:#7c3aed,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef daemonset fill:#f59e0b,stroke:#d97706,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef job fill:#14b8a6,stroke:#0d9488,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef cronjob fill:#06b6d4,stroke:#0891b2,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef hpa fill:#f43f5e,stroke:#e11d48,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef pvc fill:#a78bfa,stroke:#7c3aed,stroke-width:2px,color:#fff\n`;
  syntax += `    classDef pv fill:#c4b5fd,stroke:#7c3aed,stroke-width:2px,color:#333\n`;
  syntax += `    classDef nsresource fill:#d1fae5,stroke:#6ee7b7,stroke-width:2px,color:#333\n`;
  syntax += `    classDef serviceaccount fill:#fde68a,stroke:#f59e0b,stroke-width:2px,color:#333\n`;
  syntax += `    classDef networkpolicy fill:#fca5a5,stroke:#ef4444,stroke-width:2px,color:#333\n`;
  syntax += `    classDef storageclass fill:#e5e7eb,stroke:#9ca3af,stroke-width:2px,color:#333\n`;

  // Apply styles (only to nodes that exist)
  const styledNodes = new Set<string>();
  resources.forEach(r => {
    const nodeId = sanitizeNodeId(`${r.kind}_${r.name}`);
    const kindLower = r.kind.toLowerCase();
    let styleClass = '';
    
    styleClass = getStyleClass(kindLower);
    
    if (styleClass && !styledNodes.has(nodeId) && existingNodeIds.has(nodeId)) {
      // Ensure nodeId is sanitized and doesn't contain newlines or special characters
      const safeNodeId = sanitizeNodeId(nodeId);
      syntax += `    class ${safeNodeId} ${styleClass}\n`;
      styledNodes.add(safeNodeId);
    }
  });
  
  // Also style any nodes created from relationships that weren't in resources
  relationships.forEach(rel => {
    const toParts = rel.to.split(':');
    const toId = sanitizeNodeId(`${toParts[0]}_${toParts[1]}`);
    const kindLower = toParts[0].toLowerCase();
    
    // Only style if not already styled and node exists
    if (!styledNodes.has(toId) && existingNodeIds.has(toId)) {
      const styleClass = getStyleClass(kindLower);

      if (styleClass) {
        // Ensure toId is sanitized and doesn't contain newlines or special characters
        const safeToId = sanitizeNodeId(toId);
        syntax += `    class ${safeToId} ${styleClass}\n`;
        styledNodes.add(safeToId);
      }
    }
  });

  return syntax;
}

/**
 * Generate Kubernetes architecture diagram from manifests
 */
export async function generateKubernetesDiagram(
  manifests: string[],
  useAI: boolean = true,
  diagramType: DiagramType = 'flowchart'
): Promise<DiagramResult> {
  console.log('\n📊 ========== KUBERNETES DIAGRAM GENERATION ==========');
  console.log(`Processing ${manifests.length} manifest(s)`);
  console.log(`Diagram Type: ${diagramType}`);

  // Parse resources
  const resources = parseKubernetesResources(manifests);
  console.log(`✅ Parsed ${resources.length} resource(s)`);

  // Extract relationships
  const relationships = extractRelationships(manifests, resources);
  console.log(`✅ Found ${relationships.length} relationship(s)`);

  // Generate Mermaid syntax based on diagram type
  let mermaidSyntax: string;
  
  if (diagramType === 'flowchart') {
    // Use existing flowchart generator
    mermaidSyntax = generateMermaidSyntax(resources, relationships);
  } else {
    // Convert to other diagram types
    const diagramData = {
      resources: resources.map(r => ({
        type: r.kind,
        name: r.name,
        category: r.kind, // Use kind as category for Kubernetes
      })),
      relationships: relationships.map(r => ({
        from: r.from,
        to: r.to,
        type: r.type,
      })),
    };
    
    console.log(`   📊 Converting to ${diagramType}...`);
    mermaidSyntax = convertToDiagramType(diagramData, diagramType);
    
    // If conversion returns empty, fallback to flowchart
    if (!mermaidSyntax || mermaidSyntax.trim() === '') {
      console.warn(`   ⚠️  ${diagramType} conversion returned empty, using flowchart`);
      mermaidSyntax = generateMermaidSyntax(resources, relationships);
    } else {
      console.log(`   ✅ Successfully converted to ${diagramType}`);
    }
  }

  // Optional AI enhancement (only for flowcharts)
  if (useAI && diagramType === 'flowchart') {
    try {
      console.log('\n🤖 Enhancing diagram with AI...');
      const enhanced = await enhanceWithAI(manifests, mermaidSyntax);
      mermaidSyntax = enhanced;
      console.log('✅ AI enhancement complete');
    } catch (error: any) {
      console.warn(`⚠️  AI enhancement failed: ${error.message}`);
      console.warn('📝 Using base diagram without AI enhancement');
    }
  } else if (useAI && diagramType !== 'flowchart') {
    console.log(`\n⏭️  Skipping AI enhancement for ${diagramType} diagram type`);
  }

  const resourceTypes = [...new Set(resources.map(r => r.kind))];

  const result: DiagramResult = {
    success: true,
    mermaidSyntax,
    resources,
    relationships,
    metadata: {
      totalResources: resources.length,
      totalRelationships: relationships.length,
      resourceTypes,
    },
  };

  console.log(`\n✅ Diagram generation complete!`);
  console.log(`   Resources: ${result.metadata.totalResources}`);
  console.log(`   Relationships: ${result.metadata.totalRelationships}`);
  console.log(`   Types: ${result.metadata.resourceTypes.join(', ')}`);
  console.log('==========================================\n');

  return result;
}

/**
 * Enhance Mermaid syntax with AI
 */
async function enhanceWithAI(manifests: string[], baseSyntax: string): Promise<string> {
  const systemPrompt = `You are an expert at creating clear, readable Mermaid diagrams for Kubernetes architectures.

Your task is to enhance the provided Mermaid syntax to make it more visually appealing and easier to understand.

Guidelines:
1. Keep the structure but improve layout
2. Ensure proper grouping and hierarchy
3. Add meaningful labels to relationships
4. Use appropriate colors and styling
5. Maintain all resources and relationships
6. Improve readability without changing the core structure

Return only the enhanced Mermaid syntax, no explanations.`;

  const userPrompt = `Enhance this Kubernetes Mermaid diagram:

\`\`\`mermaid
${baseSyntax}
\`\`\`

Make it clearer and more visually appealing while keeping all resources and relationships.`;

  try {
    const completion = await aiChatCompletion({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 2000,
    });

    const response = completion.choices[0]?.message?.content || '';
    
    // Extract Mermaid code block if present
    const mermaidMatch = response.match(/```(?:mermaid)?\n([\s\S]*?)```/);
    if (mermaidMatch) {
      return mermaidMatch[1].trim();
    }

    return response.trim();
  } catch (error: any) {
    console.warn(`⚠️  AI enhancement failed: ${error.message}`);
    return baseSyntax; // Return original if AI fails
  }
}

