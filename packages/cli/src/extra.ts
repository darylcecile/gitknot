import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { RunnerError, configDirectory, decodeUtf8, loadRunnerConfiguration, parseIsolation, readBounded, readJsonFile, recoverRunnerCredential, registerRunner, rotateRunnerCredential, runRunner } from '../../runner/src/index.ts';
import type { ToolchainDescriptor as WorkflowToolchain } from '../../workflows/src/index.ts';
import { API_FLAGS, requestFields, sendApi } from './api.ts';
import { checkFlags, flag, has, identifier, numberFlag, repeated, requiredFlag, type Arguments } from './args.ts';
import { apiClient, repositoryId, selectedOrigin } from './config.ts';
import { print, readHidden, readStdin, write, type CliIO } from './io.ts';

function runnerConfigPath(args: Arguments): string {
  const name = flag(args, 'name') ?? hostname().replace(/[^a-zA-Z0-9_-]/g, '-');
  return resolve(flag(args, 'config') ?? join(configDirectory(), 'runners', `${name}.json`));
}

export async function runnerCommand(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number | null> {
  const command = args.words[1];
  if (command === 'register') {
    checkFlags(args, ['config', 'name', 'toolchains', 'label', 'disposable', 'enrollment-token-stdin', 'state-dir', 'work-dir', 'isolation']);
    if (args.words.length !== 2) throw new RunnerError('usage', 'Runner enrollment tokens must be supplied through standard input.');
    const toolchains = await readJsonFile(resolve(requiredFlag(args, 'toolchains'))) as Record<string, WorkflowToolchain>;
    const token = (await readHidden(io, 'One-time GitKnot enrollment token (hidden): ')).trim();
    const registered = await registerRunner({
      api_origin: selectedOrigin(args), enrollment_token: token, name: flag(args, 'name') ?? hostname().replace(/[^a-zA-Z0-9_-]/g, '-'),
      toolchains, labels: repeated(args, 'label'), disposable: has(args, 'disposable'), configuration_path: runnerConfigPath(args),
      isolation: parseIsolation(await readJsonFile(resolve(requiredFlag(args, 'isolation')))),
      state_directory: flag(args, 'state-dir'), work_directory: flag(args, 'work-dir'),
      allow_loopback_http: has(args, 'allow-loopback-http') || process.env.GITKNOT_ALLOW_LOOPBACK_HTTP === '1',
    });
    const { machine_token: _token, ...registration } = registered.configuration.registration;
    await print(io, { ...registration, config_path: registered.path }, has(args, 'json'));
    return 0;
  }
  if (command === 'start') {
    checkFlags(args, ['config', 'name', 'once', 'max-assignments', 'grace-ms']);
    if (args.words.length !== 2) throw new RunnerError('usage', 'Use runner start --config FILE.');
    let failed = false;
    const result = await runRunner(runnerConfigPath(args), {
      signal, once: has(args, 'once'), max_assignments: flag(args, 'max-assignments') ? numberFlag(args, 'max-assignments', 1, 1, 1_000_000) : undefined,
      grace_ms: numberFlag(args, 'grace-ms', 5_000, 0, 60_000),
      onStatus: (status) => {
        if (status.outcome && !['passed', 'not_applicable'].includes(status.outcome)) failed = true;
        io.stderr.write(`${JSON.stringify(status)}\n`);
      },
    });
    await print(io, result, has(args, 'json'));
    return result.fenced || (has(args, 'once') && failed) ? 1 : 0;
  }
  if (command === 'rotate' || command === 'recover') {
    checkFlags(args, ['config', 'name']);
    const configuration = await (command === 'rotate' ? rotateRunnerCredential(runnerConfigPath(args)) : recoverRunnerCredential(runnerConfigPath(args)));
    await print(io, { [command === 'rotate' ? 'rotated' : 'recovered']: true, runner_id: configuration.registration.runner_id, credential_generation: configuration.registration.credential_generation, credential_expires_at: configuration.registration.credential_expires_at }, has(args, 'json'));
    return 0;
  }
  if (command === 'status') {
    checkFlags(args, ['config', 'name']);
    const configuration = await loadRunnerConfiguration(runnerConfigPath(args));
    const { machine_token: _token, ...registration } = configuration.registration;
    await print(io, { configured: true, api_origin: configuration.api_origin, ...registration, capabilities: configuration.capabilities }, has(args, 'json'));
    return 0;
  }
  return null;
}

async function configurationScope(args: Arguments): Promise<string> {
  const repo = await repositoryId(args, flag(args, 'repo') ?? process.env.GITKNOT_REPO);
  const account = flag(args, 'account') ?? process.env.GITKNOT_ACCOUNT;
  const environment = flag(args, 'environment');
  if (repo && flag(args, 'account')) throw new RunnerError('usage', 'Select repository or account scope explicitly.');
  if (environment && !repo) throw new RunnerError('usage', 'Environment scope requires --repo.');
  if (repo) return `/v1/repos/${identifier(repo, 'repository ID')}${environment ? `/environments/${identifier(environment, 'environment ID')}` : ''}`;
  return `/v1/accounts/${identifier(account, 'account ID (--account)')}`;
}

export async function configurationCommand(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  const secret = args.words[0] === 'secret';
  const command = args.words[1];
  checkFlags(args, [...API_FLAGS, 'repo', 'account', 'environment', 'value-stdin', 'value-file', ...(secret ? [] : ['value'])]);
  const collection = `${await configurationScope(args)}/${secret ? 'secrets' : 'variables'}`;
  if (command === 'list') return sendApi(args, io, signal, { method: 'GET', path: collection });
  const name = identifier(args.words[2], 'configuration name or ID');
  if (command === 'view') return sendApi(args, io, signal, { method: 'GET', path: `${collection}/${name}` });
  if (command === 'versions') return sendApi(args, io, signal, { method: 'GET', path: `${collection}/${name}/versions` });
  if (command === 'delete') return sendApi(args, io, signal, { method: 'DELETE', path: `${collection}/${name}` });
  if (command !== 'set') throw new RunnerError('usage', `Use ${secret ? 'secret' : 'variable'} list, view, set, versions, or delete.`);
  let value: string;
  if (flag(args, 'value-file')) value = decodeUtf8(await readBounded(resolve(flag(args, 'value-file')!), 65_536));
  else if (has(args, 'value-stdin')) value = (await readStdin(io, 65_536)).replace(/\r?\n$/, '');
  else if (!secret && flag(args, 'value') !== undefined) value = flag(args, 'value')!;
  else if (secret && io.stdin.isTTY) value = await readHidden(io, `Value for ${decodeURIComponent(name)} (hidden): `, 65_536);
  else throw new RunnerError('usage', secret ? 'Supply --value-stdin or --value-file for a secret.' : 'Supply --value, --value-stdin, or --value-file.');
  if (has(args, 'input') || repeated(args, 'field').some((field) => /^(?:value|name)=/.test(field)) || repeated(args, 'raw-field').some((field) => /^(?:value|name)=/.test(field))) throw new RunnerError('usage', 'Set uses its positional name and explicit value source; use --field for policy metadata only.');
  const client = await apiClient(args);
  if (secret) client.addRedactions([value]);
  const revision = flag(args, 'if-match');
  const body = await requestFields(args, io, {}, { value, ...(!revision ? { name: decodeURIComponent(name) } : {}) });
  if (revision && !/^"[^"\r\n]+"$/.test(revision)) throw new RunnerError('usage', '--if-match requires a quoted strong ETag.');
  const response = await client.request(revision ? 'PUT' : 'POST', revision ? `${collection}/${name}` : collection, { body, headers: revision ? { 'If-Match': revision } : {}, idempotency_key: flag(args, 'idempotency-key') ?? randomUUID(), signal });
  // Management APIs are write-only for existing secret values. Never echo a submitted secret.
  const result = secret && response.data && typeof response.data === 'object' ? Object.fromEntries(Object.entries(response.data).filter(([key]) => !['value', 'plaintext', 'ciphertext'].includes(key))) : response.data;
  await print(io, result, has(args, 'json'));
  return 0;
}

export async function searchCommand(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  checkFlags(args, [...API_FLAGS, 'repo', 'type', 'state', 'commit', 'complete']);
  const command = args.words[1];
  if (command === 'scan' || command === 'results') {
    const id = identifier(args.words[2], 'code scan ID');
    return sendApi(args, io, signal, { method: 'GET', path: `/v1/search/code-scans/${id}${command === 'results' ? '/results' : ''}` });
  }
  const query = (command === 'code' ? args.words.slice(2) : args.words.slice(1)).join(' ');
  if (!query && !has(args, 'input')) throw new RunnerError('usage', 'Supply a search query or a complete code-scan JSON input.');
  const repo = await repositoryId(args, flag(args, 'repo') ?? process.env.GITKNOT_REPO);
  if (command === 'code') {
    const body: Record<string, unknown> = query ? { query } : {};
    if (!has(args, 'input')) {
      const commit = requiredFlag(args, 'commit');
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new RunnerError('usage', 'Code search requires a full pinned --commit.');
      body.repositories = [{ repo_id: decodeURIComponent(identifier(repo, 'repository ID (--repo)')), commit_oid: commit }];
    }
    return sendApi(args, io, signal, { method: 'POST', path: '/v1/search/code-scans', body });
  }
  return sendApi(args, io, signal, { method: 'GET', path: '/v1/search', fields: { type: 'kind', state: 'state' }, body: { q: query, ...(repo ? { repo_id: repo } : {}) } });
}
