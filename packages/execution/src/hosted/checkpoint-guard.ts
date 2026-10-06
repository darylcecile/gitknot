import type { WorkflowStep } from 'cloudflare:workers';

/** Outside CI's swallowed destroy error: only durable normalized facts can return. */
export function hostedCheckpointGuard(step: WorkflowStep, persist: () => Promise<void>): WorkflowStep {
  return new Proxy(step, { get(target, property) {
    if (property === 'do') return (name: string, config: unknown, work: unknown) => {
      if (typeof work !== 'function') throw new Error('The pinned CI Workflow step contract changed.');
      return Reflect.apply(target.do, target, [name, config, async (context: unknown) => {
        let result: unknown, failed = false;
        try { result = await work(context); } catch { failed = true; }
        try { await persist(); }
        catch { throw new Error('GitKnot could not durably checkpoint the normalized attempt facts.'); }
        if (failed) throw new Error('GitKnot hosted execution failed; durable attempt facts are authoritative.');
        return result;
      }]);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
