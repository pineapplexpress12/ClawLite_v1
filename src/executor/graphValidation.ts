import type { NodeRow } from '../db/nodes.js';
import { topologicalSort } from './topologicalSort.js';

const VALID_MODELS = ['fast', 'balanced', 'strong'];

/**
 * Validate a set of nodes form a valid DAG.
 */
export function validateDAG(nodes: NodeRow[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. All node IDs are unique
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) {
      errors.push(`Duplicate node ID: ${node.id}`);
    }
    ids.add(node.id);
  }

  // 2. All dependency references are valid
  for (const node of nodes) {
    const deps: string[] = JSON.parse(node.dependencies);
    for (const depId of deps) {
      if (!ids.has(depId)) {
        errors.push(`Node ${node.id} references unknown dependency: ${depId}`);
      }
    }
  }

  // 3. No cycles (topological sort will throw if cycle detected)
  try {
    topologicalSort(nodes);
  } catch {
    errors.push('Graph contains cycles');
  }

  // 4. All models are valid
  for (const node of nodes) {
    if (!VALID_MODELS.includes(node.model)) {
      errors.push(`Node ${node.id} has invalid model: ${node.model}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
