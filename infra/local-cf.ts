import { CF_BIN, offlineEnvironment, start } from './process.ts';

function receipt(args: readonly string[], data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  if (args[1] === 'raw') return data.length > 0 && data.every(value => value && typeof value === 'object' && value.success === true && value.results && Array.isArray(value.results.rows));
  if (args[2] === 'apply') return data.every(value => value && typeof value === 'object' && value.status === '✅' && typeof value.name === 'string');
  return data.every(value => value && typeof value === 'object' && typeof value.Name === 'string');
}

/**
 * cf beta.12 can keep its local Miniflare cleanup handles open after printing
 * a completed JSON result. Only these local commands use this adapter: verify
 * the complete success receipt, allow cleanup, then terminate the local CLI.
 * No remote command or partial/failed response can enter this path.
 */
export function localCfJson(args: readonly string[], timeout = 300_000): Promise<unknown> {
  const supported = args[0] === 'd1' && (args[1] === 'raw' || args[1] === 'migrations' && ['apply', 'list'].includes(args[2] ?? ''));
  if (!supported || !args.includes('--local') || args.includes('--no-local')) throw new Error('localCfJson accepts only explicitly local D1 operations.');
  const child = start(process.execPath, [CF_BIN, ...args], { env: offlineEnvironment(), capture: true });
  let output = '';
  let errors = '';
  let complete: unknown;
  let confirmed = false;
  let stoppingAfterReceipt = false;
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGTERM');
      force = setTimeout(() => child.kill('SIGKILL'), 3000);
    }, timeout);
    const clear = () => { clearTimeout(deadline); clearTimeout(cleanup); clearTimeout(force); };
    child.stdout!.on('data', (chunk: string) => {
      clearTimeout(cleanup);
      confirmed = false;
      output += chunk;
      if (output.length > 2 * 1024 * 1024) { child.kill('SIGTERM'); return; }
      try {
        const parsed: unknown = JSON.parse(output);
        if (!receipt(args, parsed)) return;
        complete = parsed;
        confirmed = true;
        clearTimeout(cleanup);
        cleanup = setTimeout(() => {
          if (child.exitCode !== null) return;
          stoppingAfterReceipt = true;
          child.kill('SIGTERM');
          force = setTimeout(() => child.kill('SIGKILL'), 3000);
        }, 500);
      } catch { /* Wait for the rest of the JSON document. */ }
    });
    child.stderr!.on('data', (chunk: string) => { errors = (errors + chunk).slice(-16_000); });
    child.once('error', error => { clear(); reject(error); });
    child.once('close', (code, signal) => {
      clear();
      if (confirmed && (code === 0 || stoppingAfterReceipt)) resolve(complete);
      else reject(new Error(`Local cf D1 command did not produce a complete success receipt (${signal ?? code}).${errors ? `\n${errors}` : ''}`));
    });
  });
}
