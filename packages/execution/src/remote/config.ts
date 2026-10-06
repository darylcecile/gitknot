import { ApiError } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { z } from 'zod';
import { requireRemoteOrigin } from './protocol.ts';

const configSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), origin: z.string(), callback_origin: z.string(),
  producer_id: z.string().regex(/^hosted:[a-zA-Z0-9_.:-]{1,160}$/), key_binding: z.string().regex(/^HOSTED_CONTROL_KEY(?:_[A-Z0-9]+)*$/).default('HOSTED_CONTROL_KEY'),
  callback_key_binding: z.string().regex(/^HOSTED_CALLBACK_KEY(?:_[A-Z0-9]+)*$/).optional() }).strict();
export type RemoteExecutorConfiguration = z.infer<typeof configSchema>;

export function remoteExecutor(env: Bindings): RemoteExecutorConfiguration | null {
  if (env.HOSTED_REMOTE_EXECUTOR_JSON === undefined || env.HOSTED_REMOTE_EXECUTOR_JSON === '') return null;
  let value: unknown;
  try { value = JSON.parse(String(env.HOSTED_REMOTE_EXECUTOR_JSON)); } catch { throw new ApiError(503, 'remote_executor_configuration', 'Remote hosted execution is not configured correctly.'); }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(503, 'remote_executor_configuration', 'Remote hosted execution requires a pinned executor and producer identity.');
  const local = ['test', 'development'].includes(env.ENVIRONMENT) && env.HOSTED_ALLOW_LOOPBACK_HTTP === 'true';
  return { ...parsed.data, origin: requireRemoteOrigin(parsed.data.origin, local), callback_origin: requireRemoteOrigin(parsed.data.callback_origin, local) };
}

export function remoteControlKey(env: Bindings, binding: string): string {
  if (!/^HOSTED_CONTROL_KEY(?:_[A-Z0-9]+)*$/.test(binding)) throw new ApiError(503, 'remote_key_unavailable', 'The remote execution key binding is invalid.');
  const key = env[binding];
  if (typeof key !== 'string' || key.length < 32) throw new ApiError(503, 'remote_key_unavailable', 'The remote execution transport key is unavailable.');
  return key;
}
