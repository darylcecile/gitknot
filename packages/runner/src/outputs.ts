import { lstat, mkdir } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { MAX_TYPED_OUTPUT_WIRE_BYTES, WorkflowValidationError, decodeTypedValue, encodeTypedValue, type CompiledJob, type CompiledOutput, type DataType, type WorkflowLimits } from '../../workflows/src/index.ts';
import { ARCHIVE_MEDIA_TYPE, createArchive, fileDigest } from './archive.ts';
import { RunnerError } from './errors.ts';
import { atomicWrite, isFsError, readBounded, safeWorkspacePath } from './files.ts';
import { containsSecret } from './redaction.ts';
import { validateReport } from './reports.ts';
import { decodeUtf8 } from './encoding.ts';
import { OutputBudget } from './output-budget.ts';

export interface StoredOutput {
  name: string;
  kind: 'artifact' | 'report' | 'value';
  type: DataType | 'report';
  path: string;
  digest: string;
  size_bytes: number;
  media_type: string;
  retention_seconds: number;
  value?: unknown;
  file_count?: number;
}

export function decodeValue(bytes: Buffer, type: Exclude<DataType, 'artifact'>): unknown {
  const text = decodeUtf8(bytes);
  if (type === 'string') return text.replace(/\r?\n$/, '');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RunnerError('output_type', `Output must contain a valid ${type} JSON value.`); }
  if (type === 'json') return value;
  if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) throw new RunnerError('output_type', `Output must have type ${type}.`);
  return value;
}

function valueError(error: unknown): never {
  if (error instanceof WorkflowValidationError) throw new RunnerError(error.issues[0]?.code ?? 'output_type', error.issues[0]?.message ?? 'Invalid typed output.');
  throw error;
}

export function decodeOutputWire(bytes: Uint8Array, type: Exclude<DataType, 'artifact'>): unknown {
  try { return decodeTypedValue(bytes, type); } catch (error) { return valueError(error); }
}

function encodeOutputWire(value: unknown, type: Exclude<DataType, 'artifact'>): Uint8Array {
  try { return encodeTypedValue(value, type); } catch (error) { return valueError(error); }
}

export interface CollectOptions {
  workspace: string;
  destination: string;
  limits: WorkflowLimits;
  secrets: string[];
  signal?: AbortSignal;
  budget?: OutputBudget;
}

export async function collectOutputs(definitions: Record<string, CompiledOutput>, options: CollectOptions): Promise<StoredOutput[]> {
  await mkdir(options.destination, { recursive: true, mode: 0o700 });
  const outputs: StoredOutput[] = [];
  const budget = options.budget ?? new OutputBudget(options.limits);
  for (const [name, definition] of Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b))) {
    let source: string;
    try { source = await safeWorkspacePath(options.workspace, definition.path); }
    catch (error) {
      if (!definition.required && isFsError(error, 'ENOENT')) continue;
      if (isFsError(error, 'ENOENT')) throw new RunnerError('output_missing', `Required output ${name} was not produced.`);
      throw error;
    }
    const target = join(options.destination, `${name}.${definition.type === 'artifact' ? 'files.ndjson' : 'json'}`);
    budget.check(0, 1);
    if (definition.type === 'artifact') {
      const isDirectory = (await lstat(source)).isDirectory();
      const remaining = budget.remaining();
      const metadata = await createArchive(options.workspace, [definition.path], target, { max_bytes: remaining.max_output_bytes, max_files: remaining.max_output_files, secrets: options.secrets, signal: options.signal }, isDirectory ? definition.path : dirname(definition.path));
      budget.consume(metadata.size_bytes, metadata.file_count);
      outputs.push({ name, kind: 'artifact', type: 'artifact', path: target, ...metadata, media_type: ARCHIVE_MEDIA_TYPE, retention_seconds: definition.retention_seconds });
      continue;
    }
    const info = await lstat(source);
    if (!info.isFile() || info.nlink > 1) throw new RunnerError('unsafe_output', 'Typed output must be a regular file without links.');
    const bytes = await readBounded(source, Math.min(MAX_TYPED_OUTPUT_WIRE_BYTES * 8, options.limits.max_output_bytes));
    if (containsSecret(bytes, options.secrets)) throw new RunnerError('output_contains_secret', 'A typed output contains a protected credential or secret.');
    const value = decodeValue(bytes, definition.type);
    const normalized = encodeOutputWire(value, definition.type);
    if (containsSecret(normalized, options.secrets)) throw new RunnerError('output_contains_secret', 'A typed output contains a protected credential or secret.');
    budget.check(normalized.byteLength, 1);
    await atomicWrite(target, normalized);
    const metadata = await fileDigest(target, MAX_TYPED_OUTPUT_WIRE_BYTES, options.signal);
    budget.consume(metadata.size_bytes, 1);
    outputs.push({ name, kind: 'value', type: definition.type, path: target, value, file_count: 1, ...metadata, media_type: 'application/json', retention_seconds: definition.retention_seconds });
  }
  return outputs;
}

export async function collectReports(definitions: CompiledJob['reports'], options: CollectOptions): Promise<{ outputs: StoredOutput[]; failed: boolean }> {
  const outputs: StoredOutput[] = [];
  const budget = options.budget ?? new OutputBudget(options.limits);
  let failed = false;
  await mkdir(options.destination, { recursive: true, mode: 0o700 });
  for (const [name, definition] of Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b))) {
    let source: string;
    try { source = await safeWorkspacePath(options.workspace, definition.path); }
    catch (error) {
      if (!definition.required && isFsError(error, 'ENOENT')) continue;
      if (isFsError(error, 'ENOENT')) throw new RunnerError('report_missing', `Required report ${name} was not produced.`);
      throw error;
    }
    const info = await lstat(source);
    if (!info.isFile() || info.nlink > 1) throw new RunnerError('unsafe_output', 'Reports must be regular files without links.');
    budget.check(0, 1);
    const bytes = await readBounded(source, Math.min(16_777_216, budget.remaining().max_output_bytes));
    if (containsSecret(bytes, options.secrets)) throw new RunnerError('report_contains_secret', 'A report contains a protected credential or secret.');
    const validation = validateReport(bytes, definition.format);
    failed ||= validation.failed;
    const target = join(options.destination, `${name}.${definition.format === 'junit' ? 'xml' : 'json'}`);
    await atomicWrite(target, bytes);
    const metadata = await fileDigest(target, budget.remaining().max_output_bytes, options.signal);
    budget.consume(metadata.size_bytes, 1);
    outputs.push({ name, kind: 'report', type: 'report', path: target, file_count: 1, ...metadata, media_type: validation.media_type, retention_seconds: definition.retention_seconds });
  }
  return { outputs, failed };
}
