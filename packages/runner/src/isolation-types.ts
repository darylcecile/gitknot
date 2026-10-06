import { z } from 'zod';
import type { ProcessOptions, ProcessResult } from './process.ts';

export const imageIdentitySchema = z.string().regex(/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/);
export const isolationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('oci'), image: imageIdentitySchema,
    engine: z.enum(['docker', 'podman']).default('docker'), network: z.enum(['none', 'bridge']).default('none'),
    cpus: z.number().positive().max(64).default(2), memory_mb: z.number().int().min(128).max(262_144).default(2048),
    pids: z.number().int().min(16).max(4096).default(256),
  }),
  z.strictObject({ type: z.literal('posix_user'), uid: z.number().int().min(1000).max(2_147_483_647), gid: z.number().int().min(1000).max(2_147_483_647) }),
  z.strictObject({ type: z.literal('windows_user'), credential_file: z.string().min(1).max(4096) }),
]);

export type RunnerIsolation = z.infer<typeof isolationSchema>;
export interface IsolationRecord { type: RunnerIsolation['type']; id: string }

export interface IsolationContext {
  workspace: string;
  home: string;
  inputs: string;
  control: string;
  directory: string;
  deadline_at: number;
  signal?: AbortSignal;
  grace_ms: number;
  onRecord?: (record: IsolationRecord | null) => Promise<void>;
}

export interface JobIsolation {
  run(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult>;
  /** Translate a supervisor-side input/workspace path into the execution namespace. */
  path(path: string): string;
  environment(): NodeJS.ProcessEnv;
  grantInputs(): Promise<void>;
  prepare(): Promise<void>;
  stop(): Promise<void>;
}
