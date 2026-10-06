export class RunnerError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'RunnerError';
  }
}

export class RunnerApiError extends RunnerError {
  constructor(code: string, message: string, readonly status: number, readonly request_id?: string) {
    super(code, message);
    this.name = 'RunnerApiError';
  }

  get fenced(): boolean {
    return [401, 403, 404, 409, 410].includes(this.status);
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof RunnerError) return error.code;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code;
  return 'runner_failed';
}

export function abortError(signal: AbortSignal): RunnerError {
  return signal.reason instanceof RunnerError ? signal.reason : new RunnerError('cancelled', 'Execution was cancelled.');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}
