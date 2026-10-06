import type { WorkflowLimits } from '../../workflows/src/index.ts';
import { RunnerError } from './errors.ts';

/** Shared by all step artifacts, job artifacts, typed values and reports of one job. */
export class OutputBudget {
  private bytes = 0;
  private files = 0;
  constructor(private readonly limits: WorkflowLimits) {}

  remaining(): WorkflowLimits {
    return { ...this.limits, max_output_bytes: this.limits.max_output_bytes - this.bytes, max_output_files: this.limits.max_output_files - this.files };
  }

  check(bytes: number, files: number): void {
    if (this.bytes + bytes > this.limits.max_output_bytes) throw new RunnerError('output_limit', 'Combined job outputs exceed the byte limit.');
    if (this.files + files > this.limits.max_output_files) throw new RunnerError('output_file_limit', 'Combined step outputs, job outputs and reports exceed the file limit.');
  }

  consume(bytes: number, files: number): void {
    this.check(bytes, files); this.bytes += bytes; this.files += files;
  }
}
