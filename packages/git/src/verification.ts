import type { GitCheckExpression } from './types.ts';
import { matchGitPattern } from './policy.ts';

export interface GitCheckDecision { key: string; satisfied: boolean; applicable: boolean }

/** Shared all/any semantics; resolve must validate immutable trusted producer provenance. */
export async function evaluateGitChecks(expression: GitCheckExpression, paths: string[], resolve: (check: Extract<GitCheckExpression, { type: 'check' }>) => Promise<boolean>): Promise<{ satisfied: boolean; decisions: GitCheckDecision[] }> {
  if (expression.type === 'check') {
    const applicable = !expression.paths || paths.some(path =>
      (!expression.paths!.include.length || expression.paths!.include.some(pattern => matchGitPattern(pattern, path)))
      && !expression.paths!.exclude.some(pattern => matchGitPattern(pattern, path)));
    const satisfied = !applicable || await resolve(expression);
    return { satisfied, decisions: [{ key: expression.key, satisfied, applicable }] };
  }
  const decisions = [];
  for (const child of expression.checks) decisions.push(await evaluateGitChecks(child, paths, resolve));
  return { satisfied: expression.type === 'all' ? decisions.every(result => result.satisfied) : decisions.some(result => result.satisfied),
    decisions: decisions.flatMap(result => result.decisions) };
}
