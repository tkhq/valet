import type { NodeDocs } from '../docs.js';
import type { IfCondition } from './if.js';
import type { ForeachBodyNode } from './foreach.js';

// Loop bodies reuse the foreach body allowlist: no nested control flow
// (if/foreach/loop/approval/wait) — branching stays at the DAG level, and
// the exit decision belongs to `until`.
export type LoopBodyNode = ForeachBodyNode;

/**
 * Exit condition, evaluated after each iteration. Same condition shape as
 * an `if` node; `left` expressions can reference `steps.<bodyId>` (this
 * iteration's outputs), `prev.<bodyId>` (last iteration's), and
 * `iteration` (0-based).
 */
export interface LoopUntil {
  combinator?: 'and' | 'or';
  conditions: IfCondition[];
}

export interface LoopNode {
  id: string;
  type: 'loop';
  /** Body steps, run in order once per iteration. */
  body: LoopBodyNode[];
  /**
   * Hard iteration ceiling — required, because a loop's exit is usually
   * model- or data-driven and therefore unbounded by construction. The
   * cap is the author's explicit contract on cost and latency.
   */
  maxIterations: number;
  /** Omitted = run exactly maxIterations ("repeat N times"). */
  until?: LoopUntil;
  /**
   * 'fail' (default): a failed body step fails the loop node.
   * 'break': stop looping, complete with the last full iteration's steps.
   */
  onIterationError?: 'fail' | 'break';
}

export function createDefaultLoopNode(id: string): LoopNode {
  return {
    id,
    type: 'loop',
    body: [{ id: `${id}-step`, type: 'set', values: {} }],
    maxIterations: 3,
  };
}

export const loopNodeDocs: NodeDocs<LoopNode> = {
  label: 'Loop',
  description: 'Repeat body steps until a condition holds',
  longDescription: `Runs its **body steps** in order, over and over, until the \`until\`
condition holds — or the \`maxIterations\` ceiling is hit. Where a foreach
fans out over a list that already exists, a loop iterates toward a state:
draft → review → redraft until the reviewer signs off.

### The bound is not optional

An LLM-judged exit condition never provably terminates, so \`maxIterations\`
is required. Pick it as a real budget (each iteration bills every body
step), not a "large enough" number.

### Referencing values

- \`\${steps.<bodyId>}\` — a body step's output from the **current**
  iteration. Later steps see earlier ones, and \`until\` sees all of them.
- \`\${prev.<bodyId>}\` — the same map from the **previous** iteration
  (undefined on the first pass; guard with an \`exists\` check).
- \`\${iteration}\` — the 0-based iteration number.

Downstream nodes read the final iteration's outputs at
\`nodes.<loopId>.data.steps.<bodyId>\`, plus \`data.iterations\` (count run)
and \`data.satisfied\` (whether \`until\` fired before the cap).

### Drafter / reviewer

The canonical shape is two llm body steps: a drafter that writes (reading
\`prev.review\` feedback when it exists) and a reviewer with an
\`outputSchema\` like \`{ approved: boolean, feedback: string }\` — with
\`until: steps.review.approved isTrue\`.`,
  fields: {
    body: {
      help: 'Steps executed in order each iteration. Same allowlist as foreach bodies — no nested control flow.',
    },
    maxIterations: {
      help: 'Hard ceiling on iterations. Required — the loop completes with satisfied=false when it hits the cap.',
    },
    until: {
      help: 'Exit condition, checked after each iteration. Same shape as if-node conditions; reference steps.<bodyId>, prev.<bodyId>, iteration. Omit to run exactly maxIterations times.',
    },
    onIterationError: {
      help: 'fail (default) fails the loop on a failed body step; break stops looping and completes with the interrupted iteration\'s outputs up to the failing step.',
    },
  },
  gotchas: [
    'Loop iterations draw from the same cumulative per-execution budget as foreach iterations — every body-step execution counts toward the 5000 cap.',
    'prev.* is undefined on the first iteration; a drafter that reads reviewer feedback must tolerate its absence.',
  ],
};
