import type { NodeRow } from '../db/nodes.js';

/**
 * Kahn's algorithm for topological sort.
 * Returns ordered node IDs. Throws if cycle detected.
 */
export function topologicalSort(nodes: NodeRow[]): string[] {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  // Initialize
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjList.set(node.id, []);
  }

  // Build edges: if B depends on A, add edge A → B
  for (const node of nodes) {
    const deps: string[] = JSON.parse(node.dependencies);
    inDegree.set(node.id, deps.length);
    for (const depId of deps) {
      adjList.get(depId)?.push(node.id);
    }
  }

  // Queue nodes with no dependencies
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  const sorted: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    sorted.push(nodeId);

    for (const dependent of adjList.get(nodeId) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error('Cycle detected in task graph');
  }

  return sorted;
}

/**
 * Check if the graph is acyclic.
 */
export function isAcyclic(nodes: NodeRow[]): boolean {
  try {
    topologicalSort(nodes);
    return true;
  } catch {
    return false;
  }
}
