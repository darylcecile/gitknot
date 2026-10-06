import type { Sandbox } from '@cloudflare/sandbox';
import { ApiError, readBounded, sha256 } from '@gitknot/core';
import type { RemoteAttemptGrant, RemoteInput, RemoteStoredObject } from '@gitknot/execution/remote/protocol';
import type { CompletionReceipt, PlanStep } from '@gitknot/execution/types';
import { CONTROL_DIR } from '@gitknot/execution/hosted/scripts';
import { collectOutputScript, restoreInputScript } from '@gitknot/execution/hosted/output-script';
import { secretVariants } from '@gitknot/execution/redaction';
import { reportFailed } from '@gitknot/execution/reports';
import { shellQuote } from '@gitknot/execution/checkout';
import { chunks, decodedFile, writeVerifiedFile } from './files.ts';
import { attemptController } from './controller.ts';
import type { HostedEnv, HostedWorkflowParams } from './types.ts';
import { LIMITS } from './types.ts';
import type { RemoteCallbacks } from './callback.ts';

interface Collection { size_bytes: number; sha256: string; failed: boolean }

export class RemoteArtifacts {
  readonly inputs = new Map<string, string>();
  readonly stepOutputs = new Map<string, string>();
  readonly outputs: CompletionReceipt['outputs'] = [];
  private outputBytes = 0;
  private serial = 0;

  constructor(private readonly env: HostedEnv, private readonly params: HostedWorkflowParams, private readonly grant: RemoteAttemptGrant,
    private readonly sandbox: Sandbox, private readonly callbacks: RemoteCallbacks, private readonly masks: string[], private readonly remaining: (reserve?: number) => number) {}

  async restoreInputs(inputs: RemoteInput[]): Promise<void> {
    const declarations = new Set(this.grant.job.inputs.map(input => `jobs.${input.job}.${input.output}`));
    const seen = new Set<string>();
    let total = 0;
    await this.sandbox.writeFile(`${CONTROL_DIR}/restore-input.cjs`, restoreInputScript, { sessionId: '__DISABLE_SESSION__' });
    for (const input of inputs) {
      if (!declarations.has(input.reference) || seen.has(input.reference) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.object_id)
        || !/^(?:sha256:)?[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.size_bytes) || input.size_bytes < 0) throw new ApiError(409, 'input_invalid', 'An input is outside the immutable dependency list.');
      total += input.size_bytes;
      if (total > (this.grant.job.limits?.input_bytes ?? LIMITS.input_bytes)) throw new ApiError(413, 'input_limit', 'Declared inputs exceed the attempt quota.');
      const response = await this.callbacks.download('input', input.object_id);
      if (!response.body) throw new ApiError(409, 'input_invalid', 'The input download is incomplete.');
      const local = `${CONTROL_DIR}/input-${seen.size}`;
      await writeVerifiedFile(this.sandbox, local, response.body, input, input.type === 'artifact' ? LIMITS.input_bytes : 65536);
      let value: string;
      if (input.type === 'artifact') {
        value = `/tmp/gitknot-inputs/${input.reference}`;
        await this.restoreArchive(local, value);
      } else {
        const result = await this.sandbox.readFile(local, { encoding: 'utf-8', sessionId: '__DISABLE_SESSION__' });
        let parsed: unknown;
        try { parsed = JSON.parse(result.content); } catch { throw new ApiError(409, 'input_invalid', 'A typed input is invalid.'); }
        if (input.type !== 'json' && typeof parsed !== input.type) throw new ApiError(409, 'input_invalid', 'The input type does not match its declaration.');
        value = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      }
      seen.add(input.reference); this.inputs.set(input.reference, value);
    }
    if (seen.size !== declarations.size) throw new ApiError(409, 'input_unavailable', 'A declared dependency input is unavailable.');
  }

  async collectStep(step: PlanStep): Promise<void> {
    for (const [name, output] of Object.entries(step.outputs ?? {})) {
      if (!output.required && !(await this.sandbox.exists(`/workspace/${output.path}`, '__DISABLE_SESSION__')).exists) continue;
      const reference = `steps.${step.secret_step_id ?? step.id}.${name}`;
      const local = `${CONTROL_DIR}/step-value-${this.serial++}`;
      await this.collect(local, { ...output, kind: output.type === 'artifact' ? 'artifact' : 'value', max_bytes: output.type === 'artifact' ? LIMITS.output_bytes : 65536 });
      if (output.type === 'artifact') {
        const destination = `/tmp/gitknot-inputs/${reference}`;
        await this.restoreArchive(local, destination); this.stepOutputs.set(reference, destination);
      } else {
        const data = await this.sandbox.readFile(local, { encoding: 'utf-8', sessionId: '__DISABLE_SESSION__' });
        const value: unknown = JSON.parse(data.content);
        this.stepOutputs.set(reference, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
  }

  async collectJob(failedCommand: boolean): Promise<boolean> {
    let reportsFailed = false;
    for (const [name, definition] of Object.entries(this.grant.job.outputs)) {
      if (failedCommand && definition.kind !== 'report') continue;
      if (definition.required === false && !(await this.sandbox.exists(`/workspace/${definition.path}`, '__DISABLE_SESSION__')).exists) continue;
      const path = `${CONTROL_DIR}/output-${this.serial++}`;
      const type = definition.type ?? (definition.kind === 'report' ? 'json' : 'artifact');
      const metadata = await this.collect(path, { ...definition, type });
      if (definition.kind === 'report') {
        const bytes = await readBounded(decodedFile(await this.sandbox.readFileStream(path, { sessionId: '__DISABLE_SESSION__' })), Math.min(definition.max_bytes, 16 * 1024 ** 2));
        metadata.failed = reportFailed(bytes, definition.format!);
      }
      reportsFailed ||= metadata.failed;
      let sequence = 0;
      const actual = await chunks(decodedFile(await this.sandbox.readFileStream(path, { sessionId: '__DISABLE_SESSION__' })), definition.max_bytes,
        async (bytes, final) => {
          this.outputBytes += bytes.length;
          if (this.outputBytes > (this.grant.job.limits?.output_bytes ?? LIMITS.output_bytes)) throw new ApiError(413, 'output_quota_exceeded', 'The attempt exhausted its aggregate output quota.');
          const index = sequence++;
          const stored = await attemptController(this.env, this.params.attempt_id).publishObject(this.params, 'output', `output:${name}:${String(index).padStart(8, '0')}`, {
            name, sequence: index, final, data_base64: Buffer.from(bytes).toString('base64'), sha256: await sha256(bytes), size_bytes: bytes.length,
            content_type: definition.kind === 'report' && definition.format === 'junit' ? 'application/xml' : type === 'artifact' ? 'application/vnd.gitknot.files+ndjson' : 'application/json',
          });
          if (stored.size_bytes !== bytes.length) throw new ApiError(409, 'output_checksum_mismatch', 'The stored output chunk was not verified.');
        });
      if (actual.sha256 !== metadata.sha256 || actual.size_bytes !== metadata.size_bytes) throw new ApiError(409, 'output_checksum_mismatch', 'The output changed during upload.');
      const manifest = await attemptController(this.env, this.params.attempt_id).publishObject(this.params, 'output-manifest', `manifest:output:${name}`, { name, sha256: actual.sha256 });
      if (manifest.source_digest?.replace(/^sha256:/, '') !== actual.sha256) throw new ApiError(409, 'output_checksum_mismatch', 'The output manifest does not match the complete output.');
      this.outputs.push({ name, sha256: actual.sha256, size_bytes: actual.size_bytes });
    }
    return reportsFailed;
  }

  private async restoreArchive(archive: string, destination: string): Promise<void> {
    await this.sandbox.writeFile(`${CONTROL_DIR}/restore-input.cjs`, restoreInputScript, { sessionId: '__DISABLE_SESSION__' });
    const result = await this.sandbox.exec(`node ${CONTROL_DIR}/restore-input.cjs`, { timeout: Math.min(30_000, this.remaining(30_000)),
      env: { GITKNOT_INPUT_SPEC: JSON.stringify({ archive, destination, max_bytes: this.grant.job.limits?.input_bytes ?? LIMITS.input_bytes }) } });
    if (!result.success) throw new ApiError(409, 'input_invalid', 'An input archive failed safe extraction.');
  }

  private async collect(destination: string, definition: object): Promise<Collection> {
    await this.sandbox.writeFile(`${CONTROL_DIR}/collect-output.cjs`, collectOutputScript, { sessionId: '__DISABLE_SESSION__' });
    const masks = secretVariants(this.masks);
    const result = await this.sandbox.exec(`node ${CONTROL_DIR}/collect-output.cjs`, { timeout: Math.min(60_000, this.remaining(30_000)), env: {
      GITKNOT_OUTPUT_SPEC: JSON.stringify({ ...definition, destination, masks, mask_width: Math.max(1, ...masks.map(value => Buffer.byteLength(value))) }),
    } });
    if (!result.success) throw new ApiError(409, 'output_invalid', 'A declared output is missing, unsafe, secret-bearing, or exceeds its quota.');
    const metadata = JSON.parse(result.stdout) as Collection;
    if (!Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes < 0 || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new ApiError(503, 'output_invalid', 'The output collector returned invalid facts.');
    const permissions = await this.sandbox.exec(`chmod 600 ${shellQuote(destination)}`, { timeout: 5000 });
    if (!permissions.success) throw new ApiError(503, 'output_invalid', 'The collected output could not be protected.');
    return metadata;
  }
}
