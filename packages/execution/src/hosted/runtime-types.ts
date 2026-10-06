import type { PlanJob } from '../types.ts';

export interface RuntimeIdentity {
  executor_id: string;
  attempt_id: string;
  generation: number;
  grant_digest: string;
  producer_id: string;
  runtime_id: string;
  runtime_name: string;
  sandbox_id: string;
  deadline_at: string;
}
export interface RuntimeGrant extends RuntimeIdentity {
  lease_expires_at: string;
  egress: PlanJob['egress'];
  cache_bytes: number;
  source_url: string | null;
}
export interface RuntimeRecord extends RuntimeGrant {
  sealed: boolean;
  launch_claimed: boolean;
  started_at: string | null;
  destroyed_at: string | null;
  receipt_id: string | null;
  process_group_stopped: boolean;
  egress_bytes: number;
  egress_requests: number;
  egress_exhausted: boolean;
}
export interface RuntimeFacts extends RuntimeIdentity {
  sealed: boolean;
  running: boolean | null;
  in_flight: number;
  ephemeral_objects: number;
  started_at: string | null;
  destroyed_at: string | null;
  receipt_id: string | null;
  process_group_stopped: boolean;
  egress_bytes: number;
  egress_requests: number;
  egress_exhausted: boolean;
}
export const RUNTIME_KEY = 'hosted:runtime';
export const OPERATION_PREFIX = 'hosted:operation:';
export const OBJECT_PREFIX = 'hosted:object:';
