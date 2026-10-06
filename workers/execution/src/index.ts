import { ApiError, readBounded, verifyInternalRequest } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { attemptAuthSchema, completionSchema, logUploadSchema, outputUploadSchema, stepSecretsSchema, terminationSchema } from '@gitknot/execution/receipt-schemas';
import { completeRunnerAttempt, confirmRunnerTermination, runnerInput, runnerStepSecrets, uploadRunnerLog, uploadRunnerOutput } from '@gitknot/execution/runner-receipts';
import { attemptContext, executionResourceEnvironment, primary } from '@gitknot/execution/store';
import { attemptRequest } from '@gitknot/execution/transport';
import type { ReceiptAuth } from '@gitknot/execution/attempt-machine';
import { executionError } from './errors.ts';
import { Sandbox } from './sandbox.ts';
import { handleRemoteCallback } from '@gitknot/execution/remote/callbacks';

export { AttemptController } from './attempt-controller.ts';
export { Sandbox, SANDBOX } from './sandbox.ts';
export { ContainerProxy } from '@cloudflare/sandbox';
export { AdmissionController } from '@gitknot/billing';

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    try {
      const callbackId = /^\/internal\/hosted\/attempts\/(att_[a-zA-Z0-9_-]+)\//.exec(new URL(request.url).pathname)?.[1];
      if (callbackId) return await handleRemoteCallback(request, await executionResourceEnvironment(env, callbackId, 'attempt'));
      await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'execution');
      if (request.method !== 'POST') throw new ApiError(404, 'not_found', 'The execution operation was not found.');
      const path = new URL(request.url).pathname;
      const payload = JSON.parse(new TextDecoder().decode(await readBounded(request.body, 1024 * 1024))) as { body?: unknown; machine_token?: string; attempt_id?: string; generation?: number };
      if (path === '/internal/runtime/arm' || path === '/internal/runtime/destroy') {
        if (!payload.attempt_id || !Number.isInteger(payload.generation)) throw new ApiError(422, 'invalid_runtime_identity', 'The runtime identity is incomplete.');
        env = await executionResourceEnvironment(env, payload.attempt_id, 'attempt');
        const { attempt } = await attemptContext(primary(env), payload.attempt_id);
        if (attempt.generation !== payload.generation || !attempt.runtime_name || attempt.executor !== 'hosted') throw new ApiError(409, 'allocation_fenced', 'The allocation identity is stale.');
        const namespace = env.SANDBOX as DurableObjectNamespace<Sandbox>;
        const runtime = namespace.get(namespace.idFromName(attempt.runtime_name));
        const identity = { attempt_id: attempt.id, generation: attempt.generation };
        return Response.json(path.endsWith('/arm') ? await runtime.arm(identity) : await runtime.destroyAndVerify(identity));
      }
      const match = /^\/internal\/attempts\/(att_[a-zA-Z0-9_-]+)\/(heartbeat|logs|outputs|secrets|complete|terminated|inputs)(?:\/(obj_[a-zA-Z0-9_-]+))?$/.exec(path);
      if (!match || typeof payload.machine_token !== 'string') throw new ApiError(404, 'not_found', 'The execution operation was not found.');
      const id = match[1]!, action = match[2]!;
      env = await executionResourceEnvironment(env, id, 'attempt');
      const schema = action === 'logs' ? logUploadSchema : action === 'outputs' ? outputUploadSchema : action === 'secrets' ? stepSecretsSchema : action === 'complete' ? completionSchema : action === 'terminated' ? terminationSchema : attemptAuthSchema;
      const parsed = schema.safeParse(payload.body);
      if (!parsed.success) throw new ApiError(422, 'invalid_attempt_request', 'The attempt request does not match the runner protocol.');
      const auth: ReceiptAuth = { runner_id: parsed.data.runner_id, generation: parsed.data.generation, lease_token: parsed.data.lease_token, machine_token: payload.machine_token };
      switch (action) {
        case 'heartbeat': return Response.json(await attemptRequest(env, id, 'heartbeat', auth));
        case 'logs': return Response.json(await uploadRunnerLog(env, id, auth, logUploadSchema.parse(parsed.data)));
        case 'outputs': return Response.json(await uploadRunnerOutput(env, id, auth, outputUploadSchema.parse(parsed.data)));
        case 'secrets': return Response.json(await runnerStepSecrets(env, id, auth, stepSecretsSchema.parse(parsed.data)), { headers: { 'cache-control': 'no-store' } });
        case 'complete': return Response.json(await completeRunnerAttempt(env, id, auth, completionSchema.parse(parsed.data)));
        case 'terminated': return Response.json(await confirmRunnerTermination(env, id, auth, terminationSchema.parse(parsed.data)));
        case 'inputs': return runnerInput(env, id, auth, match[3]!);
        default: throw new ApiError(404, 'not_found', 'The execution operation was not found.');
      }
    } catch (error) { return executionError(error); }
  },
} satisfies ExportedHandler<Bindings>;
