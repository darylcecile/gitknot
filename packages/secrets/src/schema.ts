import { z } from 'zod';
import type { VaultPolicy } from './types.ts';

export const vaultNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).refine((name) => !name.startsWith('GITKNOT_'), 'GITKNOT_ names are reserved.');
export const resourceId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
export const principalSchema = z.object({
  id: resourceId, kind: z.enum(['user', 'application', 'service', 'agent', 'runner', 'job', 'viewer']), user_id: resourceId.nullable(),
  credential_id: resourceId.nullable(), capabilities: z.array(z.string().max(128)).max(256).nullable(),
  repository_ids: z.array(resourceId).max(256).nullable(), account_ids: z.array(resourceId).max(256).nullable(), mfa: z.boolean(),
}).strict();
export const scopeSelectorSchema = z.object({ account_id: resourceId.optional(), repo_id: resourceId.optional(), environment_id: resourceId.optional() }).strict()
  .refine((scope) => !!scope.account_id !== !!scope.repo_id, 'Select an account or a repository.')
  .refine((scope) => !scope.environment_id || !!scope.repo_id, 'An environment requires its repository.');
const allowlist = z.array(resourceId).max(256);
export const vaultPolicySchema = z.object({
  version: z.literal(1).default(1), enabled: z.boolean().default(true), repository_ids: allowlist,
  workflow_ids: allowlist.nullable().default(null), actor_ids: allowlist.nullable().default(null), environment_ids: allowlist.nullable().default(null),
  refs: z.array(z.string().min(1).max(256)).max(64).nullable().default(null), allow_cross_account: z.boolean().default(false),
  allow_self_hosted: z.boolean().default(false), runner_pool_ids: allowlist.default([]), require_environment: z.boolean().default(false),
  not_before: z.iso.datetime().transform((value) => new Date(value).toISOString()).nullable().default(null),
  expires_at: z.iso.datetime().transform((value) => new Date(value).toISOString()).nullable().default(null),
}).strict().refine((policy) => !policy.allow_self_hosted || policy.runner_pool_ids.length > 0, 'Self-hosted secret use requires an explicit runner-pool allowlist.')
  .refine((policy) => !policy.allow_cross_account || policy.repository_ids.length > 0, 'Cross-account use requires an explicit repository allowlist.')
  .refine((policy) => !policy.not_before || !policy.expires_at || policy.not_before < policy.expires_at, 'Policy expiry must follow its activation.');

export function defaultVaultPolicy(repoId: string | null): VaultPolicy {
  return vaultPolicySchema.parse({ repository_ids: repoId ? [repoId] : [] });
}

export const writeEntrySchema = z.object({
  principal: principalSchema, scope: scopeSelectorSchema, kind: z.enum(['secret', 'variable']), name: vaultNameSchema,
  value: z.string().max(16_384), description: z.string().max(1024).optional(), policy: vaultPolicySchema.optional(),
  expected_revision: z.number().int().positive().nullable(), operation_id: z.string().min(1).max(256), revoke_previous: z.boolean().optional(),
}).strict();
export const selectionSchema = z.object({
  principal: principalSchema, repo_id: resourceId, workflow_id: resourceId, commit_oid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  ref: z.string().min(1).max(256), trust_class: z.enum(['trusted', 'untrusted']), executor: z.enum(['hosted', 'self_hosted']),
  runner_pool_id: resourceId.nullable(), environment_id: resourceId.nullable(),
  steps: z.array(z.object({ step_id: resourceId, secrets: z.array(vaultNameSchema).max(64), variables: z.array(vaultNameSchema).max(128) }).strict()).min(1).max(128),
}).strict();
export const resolveSchema = z.object({ attempt_id: resourceId, generation: z.number().int().positive(), step_id: resourceId, names: z.array(vaultNameSchema).max(64) }).strict();
