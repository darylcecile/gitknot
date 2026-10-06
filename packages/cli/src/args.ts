import { RunnerError } from '../../runner/src/index.ts';

const booleanFlags = new Set(['help', 'version', 'json', 'include', 'paginate', 'watch', 'local', 'once', 'disposable', 'with-token', 'password-stdin', 'local-only', 'binary', 'no-cache', 'draft', 'follow', 'complete', 'value-stdin', 'enrollment-token-stdin', 'allow-loopback-http', 'all', 'no-color']);
const aliases: Record<string, string> = { h: 'help', R: 'repo', X: 'method', H: 'header', f: 'field', F: 'raw-field', q: 'query' };

export interface Arguments {
  words: string[];
  flags: Map<string, string[]>;
}

export function parseArguments(argv: string[]): Arguments {
  const words: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') { words.push(...argv.slice(index + 1)); break; }
    if (!token.startsWith('-') || token === '-') { words.push(token); continue; }
    const match = /^(?:--([a-z][a-z0-9-]*)|-([a-zA-Z]))(?:=(.*))?$/.exec(token);
    if (!match) throw new RunnerError('usage', 'Invalid command-line option. Use --help for syntax.');
    const name = match[1] ?? aliases[match[2]!] ?? match[2]!;
    let value = match[3];
    if (booleanFlags.has(name)) {
      if (value !== undefined) throw new RunnerError('usage', `--${name} does not take a value.`);
      value = 'true';
    } else if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('--') && next !== '-')) throw new RunnerError('usage', `--${name} requires a value.`);
      value = next; index += 1;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { words, flags };
}

export function flag(args: Arguments, name: string): string | undefined {
  const values = args.flags.get(name);
  if (values && values.length > 1) throw new RunnerError('usage', `--${name} may be supplied only once.`);
  return values?.[0];
}

export function has(args: Arguments, name: string): boolean { return args.flags.has(name); }
export function repeated(args: Arguments, name: string): string[] { return args.flags.get(name) ?? []; }

export function requiredFlag(args: Arguments, name: string): string {
  const value = flag(args, name);
  if (!value) throw new RunnerError('usage', `--${name} is required for this command.`);
  return value;
}

export function numberFlag(args: Arguments, name: string, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = flag(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RunnerError('usage', `--${name} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}

export function checkFlags(args: Arguments, allowed: string[]): void {
  const supported = new Set(['help', 'json', 'api-url', 'allow-loopback-http', 'no-color', ...allowed]);
  for (const name of args.flags.keys()) if (!supported.has(name)) throw new RunnerError('usage', `Unknown option --${name} for this command.`);
}

export function identifier(value: string | undefined, label: string): string {
  if (!value || value === '.' || value === '..' || value.length > 256 || /[\x00-\x20\\/?#]/.test(value)) throw new RunnerError('usage', `Provide a valid ${label}.`);
  return encodeURIComponent(value);
}

export function parsePair(value: string, label = 'field'): [string, string] {
  const index = value.indexOf('=');
  if (index < 1) throw new RunnerError('usage', `Use ${label} name=value.`);
  return [value.slice(0, index), value.slice(index + 1)];
}

export function parseValue(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

export function assignField(target: Record<string, unknown>, path: string, value: unknown): void {
  const names = path.split('.');
  if (names.length > 16 || names.some((name) => !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))) throw new RunnerError('usage', 'Field paths must be ordinary JSON property names.');
  let cursor = target;
  for (const name of names.slice(0, -1)) {
    if (cursor[name] === undefined) cursor[name] = {};
    if (!cursor[name] || typeof cursor[name] !== 'object' || Array.isArray(cursor[name])) throw new RunnerError('usage', 'A nested field conflicts with an existing value.');
    cursor = cursor[name] as Record<string, unknown>;
  }
  cursor[names.at(-1)!] = value;
}
