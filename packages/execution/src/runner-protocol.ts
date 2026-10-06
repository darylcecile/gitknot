import { z } from 'zod';

const fingerprint = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const runnerCapabilitiesSchema = z.object({ os: z.enum(['linux', 'darwin', 'win32']), arch: z.enum(['x64', 'arm64']),
  toolchains: z.record(z.string().min(1).max(128), fingerprint).refine(value => Object.keys(value).length <= 128),
  labels: z.array(z.string().max(64)).max(32) }).strict();
export const runnerStatusSchema = z.object({ pool_id: z.string(), capabilities: runnerCapabilitiesSchema,
  available_slots: z.number().int().min(0).max(16) }).strict();
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;

export function runnerToolchains(capabilities: z.infer<typeof runnerCapabilitiesSchema>): string[] {
  return [...new Set(Object.values(capabilities.toolchains))].sort();
}
