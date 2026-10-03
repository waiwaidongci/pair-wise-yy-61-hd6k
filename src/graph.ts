export type DependencyNode = { id: string; dependencies: string[] };

/** 检测依赖图中的回路，返回回路路径（首尾相接，如 [A, B, A]），无环返回 null。 */
export function findDependencyCycle(nodes: DependencyNode[]): string[] | null {
  const graph = new Map(nodes.map((node) => [node.id, node.dependencies]));
  const marks = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    marks.set(id, 'visiting');
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      if (!graph.has(dep)) continue;
      const mark = marks.get(dep);
      if (mark === 'visiting') return [...stack.slice(stack.indexOf(dep)), dep];
      if (!mark) {
        const cycle = visit(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    marks.set(id, 'done');
    return null;
  };
  for (const id of graph.keys()) {
    if (!marks.has(id)) {
      const cycle = visit(id);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** 收集所有（传递）依赖 changedId 的下游工卡，按由近及远排序。 */
export function collectDownstream(changedId: string, nodes: DependencyNode[]): string[] {
  const dependents = new Map<string, string[]>();
  nodes.forEach((node) => {
    node.dependencies.forEach((dep) => {
      const list = dependents.get(dep) ?? [];
      list.push(node.id);
      dependents.set(dep, list);
    });
  });
  const result: string[] = [];
  const seen = new Set<string>([changedId]);
  const queue = [changedId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of dependents.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        result.push(next);
        queue.push(next);
      }
    }
  }
  return result;
}

/** 计算某工卡的传递前置链（拓扑序，远端前置在前、直接前置在后）。 */
export function upstreamChain(id: string, nodes: DependencyNode[]): string[] {
  const graph = new Map(nodes.map((node) => [node.id, node.dependencies]));
  const result: string[] = [];
  const seen = new Set<string>([id]);
  const walk = (current: string) => {
    for (const dep of graph.get(current) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      walk(dep);
      result.push(dep);
    }
  };
  walk(id);
  return result;
}
