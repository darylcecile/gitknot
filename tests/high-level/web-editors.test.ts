import { describe, expect, it } from 'vitest';
import { fieldValues, serializeFields } from '../../apps/web/src/components/field-values.ts';
import type { Field } from '../../apps/web/src/components/field-types.ts';
import { protectedBranchRule, validateRule } from '../../apps/web/src/components/editors/rule-editor.tsx';
import { inputEntries } from '../../apps/web/src/components/editors/input-editor.tsx';
import { isolationConfiguration } from '../../apps/web/src/components/editors/isolation-editor.tsx';
import { switchProviderProtocol } from '../../apps/web/src/components/editors/provider-editor.tsx';
import { vaultDefaults, validateAccountPolicy } from '../../apps/web/src/components/editors/policy-editors.tsx';
import { validateScanRepositories } from '../../apps/web/src/components/editors/revision-picker.tsx';
import { gitRuleSchema } from '../../packages/git/src/policy.ts';
import { vaultPolicySchema } from '../../packages/secrets/src/schema.ts';
import { isolationSchema } from '../../packages/runner/src/isolation-types.ts';

describe('typed web configuration editors', () => {
  it('preserves the full rule contract and reads existing tab drafts without asking for JSON', () => {
    const config = { ...protectedBranchRule, files: { denied_paths: ['private/**'], block_secrets: true }, merge_strategies: ['squash'] };
    const fields: Field[] = [{ name: 'config', label: 'Rule', type: 'custom', required: true, validate: validateRule }];
    expect(serializeFields(fields, fieldValues(fields, { config }), true)).toEqual({ config });
    expect(serializeFields(fields, { config: JSON.stringify(config) }, true)).toEqual({ config });
    expect(gitRuleSchema.parse(config)).toEqual(config);
    expect(() => serializeFields(fields, { config: { target: [] } })).toThrow('Choose at least one');
    expect(() => serializeFields(fields, { config: '{unfinished draft' })).toThrow('Review rule');
  });

  it('keeps explicit clearing, optional secret preservation, and immutable creation fields distinct', () => {
    const fields: Field[] = [
      { name: 'name', label: 'Name', createOnly: true },
      { name: 'value', label: 'Value', type: 'password' },
      { name: 'label_ids', label: 'Labels', type: 'csv' },
      { name: 'policy', label: 'Access', type: 'custom' },
    ];
    expect(serializeFields(fields, { name: 'SECRET', value: '', label_ids: [], policy: '' }, true)).toEqual({ label_ids: [] });
    expect(serializeFields(fields, { name: 'SECRET', value: 'new secret', label_ids: [], policy: {} }, true)).toEqual({ value: 'new secret', label_ids: [], policy: {} });
  });

  it('sends scalar workflow inputs with their selected types and rejects ambiguous names', () => {
    expect(inputEntries([
      { name: 'environment', type: 'string', value: 'preview' },
      { name: 'attempts', type: 'number', value: '3' },
      { name: 'publish', type: 'boolean', value: false },
      { name: 'optional', type: 'null', value: '' },
    ])).toEqual({ environment: 'preview', attempts: 3, publish: false, optional: null });
    expect(() => inputEntries([{ name: 'attempts', type: 'number', value: '' }])).toThrow('Enter a number');
    expect(() => inputEntries([{ name: 'publish', type: 'boolean', value: true }, { name: 'publish', type: 'boolean', value: false }])).toThrow('listed twice');
    expect(() => inputEntries([{ name: '__proto__', type: 'string', value: 'x' }])).toThrow('input name');
  });

  it('generates CLI-valid isolation for the exact job platform, with bounded resources', () => {
    const image = `example.test/toolchain@sha256:${'a'.repeat(64)}`;
    const oci = isolationConfiguration({ os: 'linux', image }, { engine: 'podman', memory_mb: 4096 });
    expect(isolationSchema.parse(oci)).toEqual({ type: 'oci', image, engine: 'podman', network: 'none', cpus: 2, memory_mb: 4096, pids: 256 });
    expect(isolationSchema.parse(isolationConfiguration({ os: 'darwin' }, { uid: '1001', gid: '1002' }))).toEqual({ type: 'posix_user', uid: 1001, gid: 1002 });
    expect(isolationSchema.parse(isolationConfiguration({ os: 'win32' }, { credential_file: 'C:\\runner\\credential.xml' }))).toEqual({ type: 'windows_user', credential_file: 'C:\\runner\\credential.xml' });
    expect(() => isolationConfiguration({ os: 'linux', image }, { memory_mb: 127 })).toThrow('Memory');
    expect(() => isolationConfiguration({ os: 'darwin' }, { uid: 0, gid: 0 })).toThrow('User ID');
    expect(() => isolationConfiguration({ os: 'win32', image }, {})).toThrow('Linux image');
  });

  it('retains shared SSO mappings while removing incompatible protocol properties', () => {
    const mappings = { default_role_id: 'member', role_ceiling: ['member'] };
    expect(switchProviderProtocol({ protocol: 'oidc', issuer: 'https://id.example.test', client_id: 'client', authorization_endpoint: 'https://id.example.test/auth',
      tenant_claim: 'tenant', tenant_values: ['work'], external_id_claim: 'object_id', mappings }, 'saml')).toEqual({ protocol: 'saml', tenant_claim: 'tenant', tenant_values: ['work'], external_id_claim: 'object_id', mappings });
  });

  it('uses the vault defaults and prevents contradictory visibility choices', () => {
    expect(vaultPolicySchema.parse(vaultDefaults('r_test'))).toEqual(vaultDefaults('r_test'));
    expect(vaultDefaults('r_test').repository_ids).toEqual(['r_test']);
    expect(vaultDefaults('r_test').workflow_ids).toBeNull();
    expect(validateAccountPolicy({ allowed_repository_visibilities: ['private'], default_repository_visibility: 'public' })).toMatch(/must also be allowed/);
    expect(validateAccountPolicy({ allowed_repository_visibilities: ['private'], default_repository_visibility: 'private' })).toBeUndefined();
  });

  it('pins complete scans to one immutable revision per repository', () => {
    expect(validateScanRepositories([{ repo_id: 'r_one', commit_oid: 'a'.repeat(40) }])).toBeUndefined();
    expect(validateScanRepositories([{ repo_id: 'r_one', commit_oid: 'main' }])).toMatch(/revision/);
    expect(validateScanRepositories([{ repo_id: 'r_one', commit_oid: 'a'.repeat(40) }, { repo_id: 'r_one', commit_oid: 'b'.repeat(40) }])).toBe('Choose one revision per repository.');
  });
});
