/**
 * Provider base classes for Node-hosted control-plane tests. Business logic receives
 * explicit test storage/services; this adapter never allocates compute or fabricates
 * a Workflow/Container result. End-to-end local Workers run in actual workerd.
 */
export class RpcTarget {}

export class WorkerEntrypoint<Env = unknown> extends RpcTarget {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;
  constructor(ctx: ExecutionContext, env: Env) { super(); this.ctx = ctx; this.env = env; }
}

export class DurableObject<Env = unknown> extends RpcTarget {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) { super(); this.ctx = ctx; this.env = env; }
}

export class WorkflowEntrypoint<Env = unknown, _Params = unknown> extends WorkerEntrypoint<Env> {}

export class NonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') { super(message); this.name = name; }
}

export function connect(): never {
  throw new Error('Raw provider sockets require the workerd end-to-end environment.');
}
