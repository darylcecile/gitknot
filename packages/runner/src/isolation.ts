import { RunnerError } from './errors.ts';
import { OciIsolation, inspectIsolationImage, removeIsolationContainer } from './isolation-oci.ts';
import { PosixUserIsolation, recoverPosixUser, requireRootSupervisor } from './isolation-posix.ts';
import { WindowsUserIsolation, recoverWindowsUser } from './isolation-windows.ts';
import { isolationSchema, type IsolationContext, type IsolationRecord, type JobIsolation, type RunnerIsolation } from './isolation-types.ts';

export { isolationSchema } from './isolation-types.ts';
export type { RunnerIsolation, IsolationRecord, JobIsolation } from './isolation-types.ts';

export function parseIsolation(value: unknown): RunnerIsolation {
  const parsed = isolationSchema.safeParse(value);
  if (!parsed.success) throw new RunnerError('isolation_required', 'Configure OCI or a distinct native execution user before starting a customer runner. A same-user workspace is not credential isolation.');
  return parsed.data;
}

export async function isolationPlatform(configuration: RunnerIsolation): Promise<{ os: 'linux' | 'darwin' | 'win32'; arch: 'x64' | 'arm64'; image?: string }> {
  if (configuration.type === 'oci') {
    const image = await inspectIsolationImage(configuration);
    return { os: image.os, arch: image.arch, image: configuration.image };
  }
  if (configuration.type === 'posix_user') requireRootSupervisor(configuration);
  if (configuration.type === 'windows_user' && process.platform !== 'win32') throw new RunnerError('isolation_platform', 'Windows account isolation requires a Windows service supervisor.');
  if (!['linux', 'darwin', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new RunnerError('isolation_platform', 'Unsupported native isolation platform.');
  return { os: process.platform as 'linux' | 'darwin' | 'win32', arch: process.arch as 'x64' | 'arm64' };
}

export function createIsolation(configuration: RunnerIsolation, context: IsolationContext): JobIsolation {
  if (configuration.type === 'oci') return new OciIsolation(configuration, context);
  if (configuration.type === 'posix_user') return new PosixUserIsolation(configuration, context);
  return new WindowsUserIsolation(configuration, context);
}

export async function recoverIsolation(configuration: RunnerIsolation, record: IsolationRecord, graceMs: number, control: string): Promise<void> {
  if (configuration.type !== record.type) throw new RunnerError('isolation_identity', 'The configured backend differs from an unfinished attempt. Restore its original isolation configuration to recover it.');
  if (configuration.type === 'oci') return removeIsolationContainer(configuration, record, graceMs);
  if (configuration.type === 'posix_user') return recoverPosixUser(configuration, record, graceMs);
  return recoverWindowsUser(configuration, record, control);
}
