#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { RunnerApiError, RunnerError, isFsError } from '../../runner/src/index.ts';
import { WorkflowValidationError } from '../../workflows/src/index.ts';
import { API_FLAGS, sendApi } from './api.ts';
import { checkFlags, has, parseArguments, type Arguments } from './args.ts';
import { authCommand, cloneRepository } from './auth.ts';
import { matchCommand, semanticCommand } from './commands.ts';
import { configurationCommand, runnerCommand, searchCommand } from './extra.ts';
import { help } from './help.ts';
import { print, processIO, write, type CliIO } from './io.ts';
import { workflowCommand } from './workflows.ts';
import { accountExportCommand } from './account-exports.ts';

const aliases: Record<string, string> = { repos: 'repo', issues: 'issue', prs: 'pr', 'pull-request': 'pr', workflows: 'workflow', runs: 'run', runners: 'runner', secrets: 'secret', variables: 'variable', exports: 'export' };

async function dispatch(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  if (has(args, 'version') || args.words[0] === 'version') { await print(io, 'gitknot 0.1.0'); return 0; }
  const group = args.words[0];
  if (!group || group === 'help' || has(args, 'help') || args.words.length === 1 && group !== 'search') {
    const text = help(group === 'help' ? args.words[1] : group);
    if (!text) throw new RunnerError('usage', 'Unknown command group. Use gitknot --help.');
    await write(io.stdout, text); return 0;
  }
  if (group === 'auth') return authCommand(args, io, signal);
  if (group === 'workflow') { const result = await workflowCommand(args, io, signal); if (result !== null) return result; }
  if (group === 'runner') { const result = await runnerCommand(args, io, signal); if (result !== null) return result; }
  if (group === 'export') { const result = await accountExportCommand(args, io, signal); if (result !== null) return result; }
  if (group === 'repo' && args.words[1] === 'clone') return cloneRepository(args, io, signal);
  if (group === 'secret' || group === 'variable') return configurationCommand(args, io, signal);
  if (group === 'search') return searchCommand(args, io, signal);
  const semantic = matchCommand(args.words);
  if (semantic) return semanticCommand(semantic, args, io, signal);
  if (group === 'api') {
    checkFlags(args, API_FLAGS);
    const methodGiven = /^[A-Z]+$/i.test(args.words[1] ?? '') && !args.words[1]!.startsWith('/');
    const method = methodGiven ? args.words[1]!.toUpperCase() : has(args, 'input') || has(args, 'field') || has(args, 'raw-field') ? 'POST' : 'GET';
    const path = args.words[methodGiven ? 2 : 1];
    if (!path || args.words.length > (methodGiven ? 3 : 2)) throw new RunnerError('usage', 'Use gitknot api [METHOD] /v1/PATH.');
    return sendApi(args, io, signal, { method, path });
  }
  throw new RunnerError('usage', 'Unknown command. Use gitknot --help for the complete command reference.');
}

export async function main(argv: string[], io: CliIO = processIO): Promise<number> {
  const controller = new AbortController();
  let signalCode: number | null = null;
  const interrupt = () => { signalCode = 130; controller.abort(new RunnerError('cancelled', 'GitKnot was interrupted.')); };
  const terminate = () => { signalCode = 143; controller.abort(new RunnerError('cancelled', 'GitKnot was stopped.')); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const args = parseArguments(argv);
    if (args.words[0]) args.words[0] = aliases[args.words[0].toLowerCase()] ?? args.words[0].toLowerCase();
    const code = await dispatch(args, io, controller.signal);
    return signalCode ?? code;
  } catch (error) {
    if (isFsError(error, 'EPIPE')) return 0;
    if (error instanceof WorkflowValidationError) {
      await write(io.stderr, `${JSON.stringify({ error: { code: error.code, message: 'Workflow validation failed.', issues: error.issues } })}\n`);
      return signalCode ?? 1;
    }
    const failure = error instanceof RunnerError ? { code: error.code, message: error.message, ...(error instanceof RunnerApiError && error.request_id ? { request_id: error.request_id } : {}) }
      : isFsError(error, 'ENOENT') ? { code: 'file_not_found', message: 'A requested file or directory was not found.' }
      : isFsError(error, 'EACCES') || isFsError(error, 'EPERM') ? { code: 'permission_denied', message: 'GitKnot could not access a required local file.' }
      : { code: 'command_failed', message: 'GitKnot could not complete this command.' };
    await write(io.stderr, `${JSON.stringify({ error: failure })}\n`);
    return signalCode ?? (failure.code === 'usage' ? 2 : 1);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') process.exitCode = 1; });
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { process.stderr.write('{"error":{"code":"command_failed","message":"GitKnot could not complete this command."}}\n'); process.exitCode = 1; });
}
