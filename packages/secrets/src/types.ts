import type { Bindings, Principal } from '@gitknot/core';

export type VaultKind = 'secret' | 'variable';
export type ScopeType = 'user' | 'organization' | 'repository' | 'environment';
export interface ScopeSelector { account_id?: string; repo_id?: string; environment_id?: string }
export interface VaultScope { account_id: string; repo_id: string | null; environment_id: string | null; scope_type: ScopeType; scope_id: string }

export interface VaultPolicy {
  version: 1;
  enabled: boolean;
  repository_ids: string[];
  workflow_ids: string[] | null;
  actor_ids: string[] | null;
  environment_ids: string[] | null;
  refs: string[] | null;
  allow_cross_account: boolean;
  allow_self_hosted: boolean;
  runner_pool_ids: string[];
  require_environment: boolean;
  not_before: string | null;
  expires_at: string | null;
}

export interface VaultEntry extends VaultScope {
  id: string; kind: VaultKind; name: string; description: string; policy_json: string; policy_revision: number;
  current_version_id: string; revision: number; deleted_at: string | null; created_by: string; created_at: string; updated_at: string;
}

export interface VaultVersion {
  id: string; entry_id: string; account_id: string; version: number; ciphertext_id: string | null;
  plain_value: string | null; created_at: string; created_by: string;
}

export interface CipherIdentity extends VaultScope {
  format: 1; purpose: 'tenant_secret' | 'webhook_signing'; entry_id: string; version_id: string; name: string; version: number;
}

export interface Ciphertext {
  id: string; account_id: string; purpose: CipherIdentity['purpose']; context_json: string; iv: string; ciphertext: string; created_at: string;
}

export interface KeyWrap { ciphertext_id: string; key_id: string; iv: string; wrapped_dek: string; created_at: string }
export interface Envelope { ciphertext: Ciphertext; wrap: KeyWrap }
export interface KeyMaterial { id: string; key: CryptoKey; fingerprint: string }
export interface Keyring { current_id: string; keys: Map<string, KeyMaterial> }

export interface SecretsClientBindings extends Pick<Bindings, 'SECRETS'> {
  SECRETS_CLIENT_ID?: string;
  SECRETS_CLIENT_KEY?: string;
}
export interface SecretsBrokerBindings extends Bindings {
  SECRETS_KEK_KEYRING_JSON: string | { get(): Promise<string> };
  SECRETS_KEK_CURRENT_ID: string;
  SECRETS_SERVICE_KEYS_JSON: string | { get(): Promise<string> };
  SECRETS_BACKUP_RETENTION_SECONDS?: string;
}

export type BrokerScope = 'vault.manage' | 'vault.plan' | 'vault.resolve' | 'vault.rotate' | 'vault.lifecycle' | 'webhooks.manage' | 'webhooks.sign';
export interface BrokerClient {
  id: string; key: string; scopes: BrokerScope[]; account_ids: string[] | null; repository_ids: string[] | null;
}

export interface PlanSelectionInput {
  principal: Principal; repo_id: string; workflow_id: string; commit_oid: string; ref: string;
  trust_class: 'trusted' | 'untrusted'; executor: 'hosted' | 'self_hosted'; runner_pool_id: string | null;
  environment_id: string | null; steps: Array<{ step_id: string; secrets: string[]; variables: string[] }>;
}

export interface SelectionContext {
  account_id: string; repo_id: string; actor_id: string; actor_credential_id: string | null; workflow_id: string;
  commit_oid: string; ref: string; trust_class: 'trusted' | 'untrusted'; executor: 'hosted' | 'self_hosted';
  runner_pool_id: string | null; environment_id: string | null; policy_revision: number; routing_epoch: number;
}

export interface SelectedVersion extends VaultScope {
  name: string; kind: VaultKind; secret_id: string; entry_id: string; version_id: string; version: number; policy_revision: number;
  value?: string;
}
export interface PlanSelection {
  selection_id: string; selection_digest: string; context: SelectionContext;
  steps: Array<{ step_id: string; secrets: SelectedVersion[]; variables: SelectedVersion[] }>;
}

export interface PlanSelectionPreview {
  selection_digest: string;
  context: SelectionContext;
  steps: Array<{ step_id: string; secrets: Array<Omit<SelectedVersion, 'value'>>; variables: Array<Omit<SelectedVersion, 'value'>> }>;
}

export interface RuntimeContext extends SelectionContext {
  attempt_id: string; generation: number; run_id: string; actor_kind: Principal['kind']; actor_user_id: string | null;
  plan_digest: string; selection_digest: string; artifact_digest: string | null; destination: string | null;
  state: string; lease_expires_at: string | null; credentials_revoked_at: string | null;
  runner_id: string | null; runner_credential_generation: number | null; runner_credential_hash: string | null;
}

export interface ResolveAttemptInput { attempt_id: string; generation: number; step_id: string; names: string[] }
export interface ResolvedSecrets { values: Record<string, string>; versions: SelectedVersion[]; expires_at: string; audit_id: string }

export interface WriteEntryInput {
  principal: Principal; scope: ScopeSelector; kind: VaultKind; name: string; value: string; description?: string;
  policy?: VaultPolicy; expected_revision: number | null; operation_id: string; revoke_previous?: boolean;
}
