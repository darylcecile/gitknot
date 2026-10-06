import type { CompiledJob, WorkflowEvent } from './types.ts';
import type { WorkflowCondition } from './schema.ts';

/** Deliberately small path language: *, ** and ?. No executable expressions. */
export function matchesPath(pattern: string, path: string): boolean {
  let previous = new Uint8Array(path.length + 1);
  previous[0] = 1;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    const current = new Uint8Array(path.length + 1);
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        let prefix = false;
        for (let position = 0; position <= path.length; position += 1) {
          prefix ||= previous[position] === 1;
          current[position] = previous[position] || (prefix && path[position - 1] === '/' ? 1 : 0);
        }
        index += 2;
      } else {
        current[0] = previous[0]!;
        for (let position = 1; position <= path.length; position += 1) current[position] = previous[position] || current[position - 1]!;
        index += 1;
      }
    } else if (character === '*') {
      current[0] = previous[0]!;
      for (let position = 1; position <= path.length; position += 1) current[position] = previous[position] || (path[position - 1] !== '/' ? current[position - 1]! : 0);
    } else {
      for (let position = 1; position <= path.length; position += 1) current[position] = previous[position - 1] && (character === '?' ? path[position - 1] !== '/' : character === path[position - 1]) ? 1 : 0;
    }
    previous = current;
  }
  return previous[path.length] === 1;
}

export function evaluateCondition(condition: WorkflowCondition | undefined, event: WorkflowEvent, mayBeInapplicable: boolean): CompiledJob['condition'] {
  if (!condition) return { outcome: 'run', reason: 'No condition; verification is required.' };
  let reason: string | null = null;
  if (condition.events && !condition.events.includes(event.type)) reason = 'Event does not match the declared event condition.';
  if (condition.refs) {
    if (!event.ref) return { outcome: 'blocked', reason: 'The event does not identify its ref.' };
    if (!condition.refs.some((pattern) => matchesPath(pattern, event.ref!))) reason = 'Ref does not match the declared ref condition.';
  }
  if (condition.paths) {
    if (!event.changed_paths) return { outcome: 'blocked', reason: 'Changed-path coverage is unavailable; inapplicability cannot be established.' };
    const paths = condition.paths;
    const work = event.changed_paths.reduce((sum, path) => sum + path.length, 0) * [...paths.include, ...paths.exclude].reduce((sum, pattern) => sum + pattern.length, 0);
    if (work > 16_777_216) return { outcome: 'blocked', reason: 'Complete path-condition evaluation exceeds its bounded work budget.' };
    const matches = event.changed_paths.some((path) => paths.include.some((pattern) => matchesPath(pattern, path)) && !paths.exclude.some((pattern) => matchesPath(pattern, path)));
    if (!matches) reason = 'No changed path matches the declared path condition.';
  }
  if (!reason) return { outcome: 'run', reason: 'Declared conditions match the pinned event inputs.' };
  return mayBeInapplicable
    ? { outcome: 'not_applicable', reason: `${reason} Trusted policy permits this requirement to be inapplicable.` }
    : { outcome: 'blocked', reason: `${reason} Trusted policy has not authorized an inapplicable result.` };
}
