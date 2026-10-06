export interface WorkflowIssue {
  code: string;
  path: string;
  message: string;
}

export class WorkflowValidationError extends Error {
  readonly code = 'workflow_invalid';

  constructor(readonly issues: WorkflowIssue[]) {
    super(issues.map((issue) => `${issue.path || 'workflow'}: ${issue.message}`).join('\n'));
    this.name = 'WorkflowValidationError';
  }
}

export function invalid(code: string, path: string, message: string): never {
  throw new WorkflowValidationError([{ code, path, message }]);
}
