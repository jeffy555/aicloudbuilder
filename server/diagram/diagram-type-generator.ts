/**
 * Multi-Type Diagram Generator
 * Supports multiple Mermaid diagram types beyond flowcharts
 */

export type DiagramType = 
  | 'flowchart'
  | 'sequence'
  | 'state'
  | 'pie'
  | 'class'
  | 'mindmap'
  | 'gantt'
  | 'erDiagram'
  | 'journey'
  | 'gitGraph';

export interface DiagramGenerationOptions {
  diagramType?: DiagramType;
  theme?: 'default' | 'dark' | 'azure';
  showLabels?: boolean;
}

/**
 * Generate sequence diagram for deployment/workflow processes
 */
export function generateSequenceDiagram(
  steps: Array<{ actor: string; action: string; target: string; response?: string }>
): string {
  if (!steps || steps.length === 0) {
    console.log('[generateSequenceDiagram] No steps provided, returning empty sequence');
    return 'sequenceDiagram\n    Note over User,System: No interactions defined\n';
  }
  
  console.log(`[generateSequenceDiagram] Generating sequence with ${steps.length} steps`);
  let syntax = 'sequenceDiagram\n';
  
  // Extract unique actors
  const actors = new Set<string>();
  steps.forEach(step => {
    if (step.actor) actors.add(step.actor);
    if (step.target) actors.add(step.target);
  });
  
  // Add participants (limit to 10 to avoid clutter)
  const actorArray = Array.from(actors).slice(0, 10);
  actorArray.forEach(actor => {
    const actorId = sanitizeId(actor);
    syntax += `    participant ${actorId} as ${quoteLabel(actor)}\n`;
  });
  
  syntax += '\n';
  
  // Add interactions
  steps.slice(0, 20).forEach(step => { // Limit to 20 interactions
    if (step.actor && step.target && step.action) {
      const from = sanitizeId(step.actor);
      const to = sanitizeId(step.target);
      const action = step.action.length > 50 ? step.action.substring(0, 47) + '...' : step.action;
      syntax += `    ${from}->>${to}: ${action}\n`;
      if (step.response) {
        const response = step.response.length > 50 ? step.response.substring(0, 47) + '...' : step.response;
        syntax += `    ${to}-->>${from}: ${response}\n`;
      }
    }
  });
  
  console.log(`[generateSequenceDiagram] Generated sequence diagram (${syntax.split('\n').length} lines)`);
  return syntax;
}

/**
 * Generate state diagram for resource lifecycles
 */
export function generateStateDiagram(
  states: Array<{ name: string; transitions: Array<{ to: string; label?: string }> }>,
  initialState: string = '[*]',
  finalState: string = '[*]'
): string {
  let syntax = 'stateDiagram-v2\n';
  
  // Add initial state
  if (initialState === '[*]') {
    syntax += `    [*] --> ${sanitizeId(states[0]?.name || 'start')}\n`;
  } else {
    syntax += `    [*] --> ${sanitizeId(initialState)}\n`;
  }
  
  // Add states and transitions
  states.forEach(state => {
    const stateId = sanitizeId(state.name);
    state.transitions.forEach(transition => {
      const toId = sanitizeId(transition.to);
      const label = transition.label ? ` : ${transition.label}` : '';
      syntax += `    ${stateId} --> ${toId}${label}\n`;
    });
  });
  
  // Add final state
  if (finalState === '[*]') {
    const lastState = states[states.length - 1];
    if (lastState) {
      syntax += `    ${sanitizeId(lastState.name)} --> [*]\n`;
    }
  } else {
    syntax += `    ${sanitizeId(finalState)} --> [*]\n`;
  }
  
  return syntax;
}

/**
 * Generate pie chart for resource distribution
 */
export function generatePieChart(
  title: string,
  data: Array<{ label: string; value: number }>
): string {
  if (!data || data.length === 0) {
    return `pie title ${escapeText(title)}\n    "No Data" : 1\n`;
  }
  
  let syntax = `pie title ${escapeText(title)}\n`;
  
  data.forEach(item => {
    syntax += `    ${quoteLabel(item.label)} : ${item.value}\n`;
  });
  
  console.log(`[generatePieChart] Generated pie chart with ${data.length} items`);
  return syntax;
}

/**
 * Generate class diagram for resource hierarchies
 */
export function generateClassDiagram(
  classes: Array<{
    name: string;
    properties?: Array<{ name: string; type: string; visibility?: '+' | '-' | '#' }>;
    methods?: Array<{ name: string; returnType?: string; visibility?: '+' | '-' | '#' }>;
  }>,
  relationships?: Array<{ from: string; to: string; type: 'extends' | 'implements' | 'uses' }>
): string {
  let syntax = 'classDiagram\n';
  
  // Add classes
  classes.forEach(cls => {
    syntax += `    class ${sanitizeId(cls.name)} {\n`;
    
    // Add properties
    if (cls.properties) {
      cls.properties.forEach(prop => {
        const vis = prop.visibility || '+';
        syntax += `        ${vis}${prop.type} ${prop.name}\n`;
      });
    }
    
    // Add methods
    if (cls.methods) {
      cls.methods.forEach(method => {
        const vis = method.visibility || '+';
        const returnType = method.returnType ? ` ${method.returnType}` : '';
        syntax += `        ${vis}${method.name}()${returnType}\n`;
      });
    }
    
    syntax += `    }\n\n`;
  });
  
  // Add relationships
  if (relationships) {
    relationships.forEach(rel => {
      const from = sanitizeId(rel.from);
      const to = sanitizeId(rel.to);
      let arrow = '-->';
      
      switch (rel.type) {
        case 'extends':
          arrow = '<|--';
          break;
        case 'implements':
          arrow = '<|..';
          break;
        case 'uses':
          arrow = '-->';
          break;
      }
      
      syntax += `    ${from} ${arrow} ${to}\n`;
    });
  }
  
  return syntax;
}

/**
 * Generate mindmap for hierarchical organization.
 *
 * @param maxDepth - Maximum depth below root (default 4). Nodes at a depth
 *   beyond the limit are replaced with a single `(...)` ellipsis node to
 *   keep the Mermaid syntax valid and prevent silent truncation.
 *   depth 1 = branch labels, depth 2 = children, depth 3 = grandchildren.
 */
export function generateMindmap(
  root: string,
  branches: Array<{
    label: string;
    children?: Array<{ label: string; children?: Array<{ label: string }> }>;
  }>,
  maxDepth: number = 4
): string {
  let syntax = `mindmap\n`;
  syntax += `  root((${quoteLabel(root)}))\n`;

  for (const branch of branches) {
    syntax += `    ${quoteLabel(branch.label)}\n`;

    if (maxDepth < 2) {
      if (branch.children && branch.children.length > 0) {
        syntax += `      "(...)\"\n`;
      }
      continue;
    }

    const children = branch.children || [];
    for (const child of children) {
      syntax += `      ${quoteLabel(child.label)}\n`;

      if (maxDepth < 3) {
        if (child.children && child.children.length > 0) {
          syntax += `        "(...)\"\n`;
        }
        continue;
      }

      const grandchildren = child.children || [];
      if (grandchildren.length > 0) {
        if (maxDepth >= 3) {
          for (const grandchild of grandchildren) {
            syntax += `        ${quoteLabel(grandchild.label)}\n`;
          }
        } else {
          syntax += `        "(...)\"\n`;
        }
      }
    }
  }

  return syntax;
}

export function generateGanttChart(
  title: string,
  tasks: Array<{ label: string; durationDays: number }>
): string {
  if (!tasks || tasks.length === 0) {
    return `gantt\ntitle ${escapeText(title)}\ndateFormat  YYYY-MM-DD\n    section Timeline\n    Idle :done, 2024-01-01, 1d\n`;
  }

  const formatDate = (date: Date) => date.toISOString().split('T')[0];
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  let syntax = `gantt\ntitle ${escapeText(title)}\ndateFormat  YYYY-MM-DD\n    section Timeline\n`;

  tasks.slice(0, 6).forEach((task, index) => {
    const taskStart = new Date(start);
    taskStart.setDate(taskStart.getDate() + index * 2);
    const duration = task.durationDays > 0 ? task.durationDays : 2;
    syntax += `    ${quoteLabel(task.label)} :active, task${index}, ${formatDate(taskStart)}, ${duration}d\n`;
  });

  return syntax;
}

export function generateErDiagram(
  entities: Array<{ name: string; fields?: string[] }>,
  relationships: Array<{ from: string; to: string; label?: string }>
): string {
  if (!entities.length) {
    return 'erDiagram\n    Empty ||--|| Empty : none\n';
  }

  let syntax = 'erDiagram\n';
  entities.slice(0, 6).forEach(entity => {
    const entityId = sanitizeId(entity.name);
    const entityLabel = sanitizeLabel(entity.name);
    syntax += `    ${entityId} as "${entityLabel}" {\n`;
    (entity.fields || ['id']).forEach(field => {
      const fieldId = sanitizeId(field);
      syntax += `        string ${fieldId}\n`;
    });
    syntax += '    }\n';
  });

  relationships.slice(0, 12).forEach(rel => {
    const label = rel.label ? ` : ${rel.label}` : '';
    syntax += `    ${sanitizeId(rel.from)} ||--|| ${sanitizeId(rel.to)}${label}\n`;
  });

  return syntax;
}

export function generateJourneyDiagram(
  steps: Array<{ actor: string; action: string; target: string }>
): string {
  if (!steps || steps.length === 0) {
    return 'journey\n  title Architecture journey\n  section Waiting\n    Standing by: 1\n';
  }

  let syntax = 'journey\n  title Architecture journey\n';
  syntax += '  section Flow\n';
  steps.slice(0, 6).forEach(step => {
    syntax += `    ${quoteLabel(step.actor)} : ${escapeText(step.action)} → ${quoteLabel(step.target)}\n`;
  });
  return syntax;
}

export function generateGitGraphDiagram(
  commits: Array<{ message: string }>
): string {
  if (!commits || commits.length === 0) {
    return 'gitGraph\n    commit id: "Initial commit"\n';
  }

  let syntax = 'gitGraph\n';
  commits.slice(0, 5).forEach((commit, idx) => {
    const msg = commit.message.length > 40 ? commit.message.slice(0, 37) + '...' : commit.message;
    syntax += `    commit id: "${sanitizeLabel(msg)}"\n`;
    if (idx === 1) {
      syntax += '    branch feature\n    checkout feature\n    commit id: "Feature added"\n    checkout main\n';
    }
  });
  return syntax;
}

/**
 * Sanitize ID for Mermaid (remove special characters, spaces)
 */
function sanitizeId(id: string): string {
  return id
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^\d/, 'id_$&');
}

function sanitizeLabel(label: string): string {
  return label
    .replace(/[^a-zA-Z0-9_ ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 40);
}

function quoteLabel(value: string): string {
  const cleaned = sanitizeLabel(value);
  return `"${cleaned || 'item'}"`;
}

function escapeText(text: string): string {
  return text
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/**
 * Convert architecture data to different diagram types
 */
export function convertToDiagramType(
  data: {
    resources?: Array<{ type: string; name: string; category?: string }>;
    relationships?: Array<{ from: string; to: string; type: string }>;
    workflow?: Array<{ actor: string; action: string; target: string }>;
    states?: Array<{ name: string; transitions: Array<{ to: string }> }>;
    statistics?: Array<{ label: string; value: number }>;
  },
  diagramType: DiagramType
): string {
  switch (diagramType) {
    case 'sequence':
      if (data.workflow && data.workflow.length > 0) {
        return generateSequenceDiagram(
          data.workflow.map(w => ({
            actor: w.actor,
            action: w.action,
            target: w.target,
          }))
        );
      }
      // Fallback: create sequence from relationships
      if (data.relationships && data.relationships.length > 0) {
        const steps = data.relationships.map(rel => ({
          actor: rel.from,
          action: `uses ${rel.type}`,
          target: rel.to,
        }));
        return generateSequenceDiagram(steps);
      }
      // If no relationships, create from resources
      if (data.resources && data.resources.length > 0) {
        const steps = data.resources.slice(0, 5).map((r, idx) => ({
          actor: 'User',
          action: `creates ${r.type}`,
          target: r.name,
        }));
        return generateSequenceDiagram(steps);
      }
      break;
      
    case 'state':
      if (data.states && data.states.length > 0) {
        return generateStateDiagram(data.states);
      }
      // Fallback: create states from resource lifecycle
      if (data.resources && data.resources.length > 0) {
        return generateStateDiagram([
          { name: 'Created', transitions: [{ to: 'Provisioning', label: 'start' }] },
          { name: 'Provisioning', transitions: [{ to: 'Running', label: 'deploy' }] },
          { name: 'Running', transitions: [{ to: 'Stopped', label: 'stop' }, { to: 'Deleted', label: 'delete' }] },
          { name: 'Stopped', transitions: [{ to: 'Running', label: 'start' }] },
          { name: 'Deleted', transitions: [] },
        ], '[*]', '[*]');
      }
      break;
      
    case 'pie':
      if (data.statistics && data.statistics.length > 0) {
        return generatePieChart('Resource Distribution', data.statistics);
      }
      // Fallback: create pie from resource categories
      if (data.resources && data.resources.length > 0) {
        const categoryCounts = new Map<string, number>();
        data.resources.forEach(r => {
          const cat = r.category || 'Other';
          categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
        });
        const stats = Array.from(categoryCounts.entries()).map(([label, value]) => ({
          label,
          value,
        }));
        if (stats.length > 0) {
          return generatePieChart('Resource Distribution', stats);
        }
      }
      break;
      
    case 'class':
      if (data.resources && data.resources.length > 0) {
        // Group by type to avoid duplicates
        const typeMap = new Map<string, { name: string; properties: Array<{ name: string; type: string; visibility: '+' }> }>();
        data.resources.forEach(r => {
          if (!typeMap.has(r.type)) {
            typeMap.set(r.type, {
              name: r.type,
              properties: [{ name: 'name', type: 'string', visibility: '+' as const }],
            });
          }
        });
        const classes = Array.from(typeMap.values());
        const relationships = data.relationships?.map(r => ({
          from: r.from.split('.').pop() || r.from,
          to: r.to.split('.').pop() || r.to,
          type: 'uses' as const,
        }));
        return generateClassDiagram(classes, relationships);
      }
      break;
      
    case 'mindmap':
      if (data.resources && data.resources.length > 0) {
        const categories = new Map<string, string[]>();
        data.resources.forEach(r => {
          const cat = r.category || 'Other';
          if (!categories.has(cat)) {
            categories.set(cat, []);
          }
          categories.get(cat)!.push(r.name);
        });
        const branches = Array.from(categories.entries()).map(([label, children]) => ({
          label,
          children: children.slice(0, 10).map(name => ({ label: name })), // Limit to 10 per category
        }));
        if (branches.length > 0) {
          return generateMindmap('Resources', branches);
        }
      }
      break;
    case 'gantt':
      return generateGanttChart(
        'Resource timeline',
        (data.resources || []).map(resource => ({
          label: resource.name,
          durationDays: Math.max(1, Math.min(5, resource.name.length % 5 + 1))
        }))
      );
    case 'erDiagram':
      return generateErDiagram(
        (data.resources || []).map(resource => ({
          name: resource.name,
          fields: [`type=${resource.type}`]
        })),
        (data.relationships || []).map(rel => ({
          from: rel.from,
          to: rel.to,
          label: rel.type
        }))
      );
    case 'journey':
      return generateJourneyDiagram(
        (data.workflow && data.workflow.length > 0)
          ? data.workflow
          : (data.relationships || []).map(rel => ({
              actor: rel.from,
              action: rel.type,
              target: rel.to
            }))
      );
    case 'gitGraph':
      return generateGitGraphDiagram(
        (data.resources || []).slice(0, 5).map(resource => ({
          message: `Add ${resource.name}`
        }))
      );
      
    case 'flowchart':
    default:
      // Return empty - handled by existing flowchart generator
      return '';
  }
  
  return '';
}

