import { ApiError } from '@gitknot/core';

export class BillingError extends ApiError {
  declare readonly status: 400 | 403 | 404 | 409 | 412 | 422 | 429 | 503;
  constructor(
    code: string,
    message: string,
    status: BillingError['status'] = 409,
    details?: Record<string, unknown>,
  ) {
    super(status, code, message, details);
    this.name = 'BillingError';
  }
}

export function invariant(condition: unknown, code: string, message: string, status: BillingError['status'] = 409): asserts condition {
  if (!condition) throw new BillingError(code, message, status);
}
