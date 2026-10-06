import type { Bindings, EventRecord } from '@gitknot/core';

export type Consumer = 'webhooks' | 'mail' | 'index' | 'meter' | 'operations';
export const consumers: readonly Consumer[] = ['webhooks', 'mail', 'index', 'meter', 'operations'];

export interface EmailBinding {
  send(message: {
    from: { email: string; name: string };
    to: string;
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface OperationsBindings extends Bindings {
  INDEX_EVENTS: Queue<{ event_id: string; consumer?: Consumer; cell_id?: string; shard_id?: string }>;
  METER_EVENTS: Queue<{ event_id: string; consumer?: Consumer; cell_id?: string; shard_id?: string }>;
  WEBHOOK_EGRESS: Fetcher;
  EMAIL: EmailBinding;
  SECRETS_CLIENT_ID?: string;
  SECRETS_CLIENT_KEY?: string;
  BACKGROUND?: Fetcher;
  METRICS?: AnalyticsEngineDataset;
}

export interface ConsumerJob {
  event_id: string;
  consumer: Consumer;
  state: 'pending' | 'running' | 'completed' | 'failed';
  attempts: number;
  due_at: string;
  lease_token: string | null;
  lease_until: string | null;
  cursor: string | null;
}

export interface Webhook {
  id: string;
  repo_id: string;
  account_id: string;
  installation_id: string | null;
  principal_id: string;
  principal_json: string;
  url: string;
  events_json: string;
  state: 'active' | 'disabled' | 'revoked';
  revision: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface Delivery {
  id: string;
  event_id: string;
  webhook_id: string;
  repo_id: string;
  account_id: string;
  generation: number;
  state: 'pending' | 'sending' | 'succeeded' | 'failed' | 'cancelled';
  attempt_count: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_until: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  last_status: number | null;
  error_code: string | null;
}

export interface OutboundResponse {
  status: number;
  retry_after: string | null;
  response_excerpt: string;
  response_truncated: boolean;
  duration_ms: number;
}

export interface Operation {
  id: string;
  kind: string;
  resource_id: string;
  repo_id: string | null;
  account_id: string | null;
  actor_id: string;
  status: 'pending' | 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';
  phase: string;
  progress: number;
  input_json: string;
  result_json: string | null;
  error_json: string | null;
  workflow_id: string | null;
  lease_expires_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface NativeReceipt {
  operation_id: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
  verified?: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message?: string };
}

export interface PublicEvent extends Omit<EventRecord, 'data'> {
  data: Record<string, unknown>;
}
