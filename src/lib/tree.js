/**
 * The reporting tree — FRD BR-MST-3/4, BR-ROL-4.
 *
 * `reports_to` arrives with the import; the contractor already holds it in
 * their own employee records. We never build an org tree by hand.
 *
 * Two things must hold, and both are checked before anything is written:
 *   1. Every reports_to resolves to an employee that exists (BR-MST-3)
 *   2. There is no cycle (BR-MST-4)
 *
 * A cycle is not a cosmetic problem. Escalation walks upward: A's missed
 * punch notifies A's senior. In a cycle that walk never terminates, and the
 * one feature that protects a worker from being wrongly marked absent hangs.
 */

/**
 * Find every cycle in a reports_to graph.
 *
 * @param {Map<string,string|null>} edges  employee_id -> reports_to (or null)
 * @returns {string[][]} one array of employee_ids per cycle found
 */
export function findCycles(edges) {
  const cycles = [];
  const seenCycle = new Set();

  // 0 = unvisited, 1 = on the current path, 2 = fully explored
  const state = new Map();
  for (const id of edges.keys()) state.set(id, 0);

  for (const start of edges.keys()) {
    if (state.get(start) !== 0) continue;

    const path = [];
    const indexOnPath = new Map();
    let current = start;

    while (current !== null && current !== undefined) {
      if (indexOnPath.has(current)) {
        // Closed a loop — take the slice from first sighting to here.
        const cycle = path.slice(indexOnPath.get(current));
        const key = canonicalCycleKey(cycle);
        if (!seenCycle.has(key)) {
          seenCycle.add(key);
          cycles.push(cycle);
        }
        break;
      }
      if (state.get(current) === 2) break; // known-clean territory
      if (!edges.has(current)) break;      // dangling — BR-MST-3 reports it

      indexOnPath.set(current, path.length);
      path.push(current);
      state.set(current, 1);

      current = edges.get(current) ?? null;
    }

    for (const id of path) state.set(id, 2);
  }

  return cycles;
}

/** Rotation-independent key, so A→B→A and B→A→B are one cycle, not two. */
function canonicalCycleKey(cycle) {
  if (cycle.length === 0) return '';
  let min = 0;
  for (let i = 1; i < cycle.length; i++) if (cycle[i] < cycle[min]) min = i;
  return [...cycle.slice(min), ...cycle.slice(0, min)].join('>');
}

/**
 * Employee ids referenced as a senior but present nowhere. FRD BR-MST-3.
 * Reported, never silently dropped.
 */
export function findUnresolvedSeniors(edges, existingIds = new Set()) {
  const missing = new Set();
  for (const [, seniorId] of edges) {
    if (seniorId === null || seniorId === undefined || seniorId === '') continue;
    if (edges.has(seniorId)) continue;
    if (existingIds.has(seniorId)) continue;
    missing.add(seniorId);
  }
  return [...missing];
}

/**
 * Everyone whose reports_to chain leads to `rootId` — direct and indirect.
 * This is exactly what a senior may see, and nothing more. FRD BR-ROL-4.
 *
 * @param {Map<string,string|null>} edges employee_id -> reports_to
 */
export function descendantsOf(rootId, edges) {
  const children = new Map();
  for (const [id, senior] of edges) {
    if (!senior) continue;
    if (!children.has(senior)) children.set(senior, []);
    children.get(senior).push(id);
  }

  const out = [];
  const queue = [...(children.get(rootId) ?? [])];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const id = queue.shift();
    out.push(id);
    for (const child of children.get(id) ?? []) {
      // `seen` also stops a malformed cycle from hanging this walk, even
      // though import should have rejected it long before now.
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return out;
}
