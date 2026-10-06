import { ScimError } from './errors.ts';
import { SCIM_ENTERPRISE_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_USER_SCHEMA } from './types.ts';

type Comparison = 'eq' | 'ne' | 'co' | 'sw' | 'ew' | 'pr' | 'gt' | 'ge' | 'lt' | 'le';
type Scalar = string | number | boolean | null;
export type ScimFilter = { type: 'comparison'; path: string; op: Comparison; value: Scalar }
  | { type: 'and'; left: ScimFilter; right: ScimFilter }
  | { type: 'or'; left: ScimFilter; right: ScimFilter }
  | { type: 'not'; expression: ScimFilter }
  | { type: 'value'; path: string; expression: ScimFilter };

const operators = new Set(['eq', 'ne', 'co', 'sw', 'ew', 'pr', 'gt', 'ge', 'lt', 'le']);
const invalid = () => new ScimError(400, 'The filter contains an invalid or unsupported expression.', 'invalidFilter');

function tokenize(value: string): string[] {
  if (!value.length || value.length > 2048) throw invalid();
  const tokens: string[] = [];
  let position = 0;
  while (position < value.length) {
    if (/\s/.test(value[position]!)) { position++; continue; }
    const match = /^(?:"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[()[\]]|[A-Za-z][A-Za-z0-9_:./-]*|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(value.slice(position));
    if (!match) throw invalid();
    tokens.push(match[0]);
    if (tokens.length > 128) throw invalid();
    position += match[0].length;
  }
  return tokens;
}

export function normalizeAttributePath(value: string): string {
  const lower = value.toLowerCase();
  for (const schema of [SCIM_USER_SCHEMA, SCIM_GROUP_SCHEMA]) {
    if (lower.startsWith(`${schema.toLowerCase()}:`)) return lower.slice(schema.length + 1);
  }
  if (lower.startsWith(`${SCIM_ENTERPRISE_SCHEMA.toLowerCase()}:`)) return `enterprise.${lower.slice(SCIM_ENTERPRISE_SCHEMA.length + 1)}`;
  return lower;
}

class FilterParser {
  private position = 0;
  constructor(private readonly tokens: string[]) {}
  parse(): ScimFilter {
    const result = this.or(0);
    if (this.position !== this.tokens.length) throw invalid();
    return result;
  }
  private take(): string { const value = this.tokens[this.position++]; if (value === undefined) throw invalid(); return value; }
  private is(value: string): boolean { return this.tokens[this.position]?.toLowerCase() === value; }
  private or(depth: number): ScimFilter {
    let value = this.and(depth);
    while (this.is('or')) { this.take(); value = { type: 'or', left: value, right: this.and(depth) }; }
    return value;
  }
  private and(depth: number): ScimFilter {
    let value = this.atom(depth);
    while (this.is('and')) { this.take(); value = { type: 'and', left: value, right: this.atom(depth) }; }
    return value;
  }
  private atom(depth: number): ScimFilter {
    if (depth > 8) throw invalid();
    if (this.is('not')) {
      this.take();
      if (this.take() !== '(') throw invalid();
      const expression = this.or(depth + 1);
      if (this.take() !== ')') throw invalid();
      return { type: 'not', expression };
    }
    if (this.is('(')) {
      this.take();
      const expression = this.or(depth + 1);
      if (this.take() !== ')') throw invalid();
      return expression;
    }
    const raw = this.take();
    if (!/^[A-Za-z][A-Za-z0-9_:./-]*$/.test(raw)) throw invalid();
    const path = normalizeAttributePath(raw);
    if (this.is('[')) {
      this.take();
      const expression = this.or(depth + 1);
      if (this.take() !== ']') throw invalid();
      return { type: 'value', path, expression };
    }
    const op = this.take().toLowerCase();
    if (!operators.has(op)) throw invalid();
    if (op === 'pr') return { type: 'comparison', path, op, value: null };
    let value: unknown;
    try { value = JSON.parse(this.take()); } catch { throw invalid(); }
    if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) throw invalid();
    return { type: 'comparison', path, op: op as Comparison, value: value as Scalar };
  }
}

export function parseScimFilter(value: string): ScimFilter { return new FilterParser(tokenize(value)).parse(); }
export function scimFold(value: string): string { return value.normalize('NFKC').toLowerCase(); }

interface Column { sql: string; type: 'string' | 'boolean' | 'date'; exact?: boolean }
interface Scope { kind: 'User' | 'Group'; alias: string; collection?: string }

function column(scope: Scope, path: string): Column {
  if (scope.collection) {
    const fields: Record<string, Column> = {
      value: { sql: `json_extract(${scope.alias}.value,'$.value')`, type: 'string', exact: ['members', 'groups'].includes(scope.collection) },
      display: { sql: `json_extract(${scope.alias}.value,'$.display')`, type: 'string' },
      type: { sql: `json_extract(${scope.alias}.value,'$.type')`, type: 'string' },
      primary: { sql: `json_extract(${scope.alias}.value,'$.primary')`, type: 'boolean' },
    };
    if (!fields[path]) throw invalid();
    return fields[path]!;
  }
  const a = scope.alias;
  const common: Record<string, Column> = {
    id: { sql: `${a}.id`, type: 'string', exact: true }, externalid: { sql: `${a}.external_id`, type: 'string', exact: true },
    'meta.created': { sql: `${a}.created_at`, type: 'date' }, 'meta.lastmodified': { sql: `${a}.updated_at`, type: 'date' },
    'meta.resourcetype': { sql: scope.kind === 'User' ? "'user'" : "'group'", type: 'string' },
  };
  if (common[path]) return common[path]!;
  if (scope.kind === 'Group') {
    if (path === 'displayname') return { sql: `${a}.display_name_key`, type: 'string' };
    throw invalid();
  }
  if (path === 'username') return { sql: `${a}.user_name_key`, type: 'string' };
  if (path === 'active') return { sql: `${a}.active`, type: 'boolean' };
  const fields: Record<string, string> = {
    displayname: '$.displayName', nickname: '$.nickName', title: '$.title', usertype: '$.userType',
    preferredlanguage: '$.preferredLanguage', locale: '$.locale', timezone: '$.timezone',
    'name.formatted': '$.name.formatted', 'name.givenname': '$.name.givenName', 'name.familyname': '$.name.familyName',
    'name.middlename': '$.name.middleName', 'name.honorificprefix': '$.name.honorificPrefix', 'name.honorificsuffix': '$.name.honorificSuffix',
    'enterprise.department': `$."${SCIM_ENTERPRISE_SCHEMA}".department`, 'enterprise.division': `$."${SCIM_ENTERPRISE_SCHEMA}".division`,
    'enterprise.organization': `$."${SCIM_ENTERPRISE_SCHEMA}".organization`, 'enterprise.costcenter': `$."${SCIM_ENTERPRISE_SCHEMA}".costCenter`,
    'enterprise.employeenumber': `$."${SCIM_ENTERPRISE_SCHEMA}".employeeNumber`,
  };
  if (!fields[path]) throw invalid();
  return { sql: `json_extract(${a}.search_json,'${fields[path]}')`, type: 'string' };
}

function comparisonSql(target: Column, op: Comparison, raw: Scalar, values: unknown[]): string {
  const field = target.sql;
  if (op === 'pr') return `(${field} IS NOT NULL${target.type === 'string' ? ` AND ${field}<>''` : ''})`;
  if (raw === null) {
    if (!['eq', 'ne'].includes(op)) throw invalid();
    return `${field} IS ${op === 'ne' ? 'NOT ' : ''}NULL`;
  }
  if (target.type === 'boolean' && (typeof raw !== 'boolean' || !['eq', 'ne'].includes(op))) throw invalid();
  if (target.type !== 'boolean' && typeof raw !== 'string') throw invalid();
  let value: string | number = typeof raw === 'boolean' ? Number(raw) : raw as string;
  if (target.type === 'date') {
    if (['co', 'sw', 'ew'].includes(op) || !Number.isFinite(Date.parse(String(value)))) throw invalid();
    value = new Date(String(value)).toISOString();
  } else if (target.type === 'string' && !target.exact) value = scimFold(String(value));
  const sqlOperators: Partial<Record<Comparison, string>> = { eq: '=', ne: '<>', gt: '>', ge: '>=', lt: '<', le: '<=' };
  if (sqlOperators[op]) { values.push(value); return `COALESCE(${field}${sqlOperators[op]}?,0)`; }
  if (op === 'co') { values.push(value); return `COALESCE(instr(${field},?)>0,0)`; }
  if (op === 'sw') { values.push(value, value); return `COALESCE(substr(${field},1,length(?))=?,0)`; }
  if (op === 'ew') { values.push(value, value); return `COALESCE(substr(${field},-length(?))=?,0)`; }
  throw invalid();
}

function collectionSql(scope: Scope, collection: string, expression: ScimFilter, values: unknown[], sequence: { value: number }): string {
  if (scope.collection) throw invalid();
  const alias = `j${sequence.value++}`;
  if (scope.kind === 'Group' && collection === 'members') {
    const nested = compileNode(expression, { ...scope, alias, collection }, values, sequence);
    return `EXISTS (SELECT 1 FROM federation_scim_group_members gm JOIN federation_scim_users su
      ON su.account_id=gm.account_id AND su.provider_id=gm.provider_id AND su.id=gm.scim_user_id,
      json_each(json_array(json_object('value',su.id,'display',su.user_name_key,'type','user'))) ${alias}
      WHERE gm.account_id=${scope.alias}.account_id AND gm.provider_id=${scope.alias}.provider_id AND gm.group_id=${scope.alias}.id
        AND su.deleted_at IS NULL AND (${nested}))`;
  }
  if (scope.kind === 'User' && collection === 'groups') {
    const nested = compileNode(expression, { ...scope, alias, collection }, values, sequence);
    return `EXISTS (SELECT 1 FROM federation_scim_group_members gm JOIN federation_scim_groups sg
      ON sg.account_id=gm.account_id AND sg.provider_id=gm.provider_id AND sg.id=gm.group_id,
      json_each(json_array(json_object('value',sg.id,'display',sg.display_name_key,'type','direct'))) ${alias}
      WHERE gm.account_id=${scope.alias}.account_id AND gm.provider_id=${scope.alias}.provider_id AND gm.scim_user_id=${scope.alias}.id
        AND sg.deleted_at IS NULL AND (${nested}))`;
  }
  const jsonPaths: Record<string, string> = { emails: '$.emails', roles: '$.roles', phonenumbers: '$.phoneNumbers' };
  if (scope.kind !== 'User' || !jsonPaths[collection]) throw invalid();
  const nested = compileNode(expression, { ...scope, alias, collection }, values, sequence);
  return `EXISTS (SELECT 1 FROM json_each(${scope.alias}.search_json,'${jsonPaths[collection]}') ${alias} WHERE ${nested})`;
}

function compileNode(node: ScimFilter, scope: Scope, values: unknown[], sequence: { value: number }): string {
  if (node.type === 'and' || node.type === 'or') return `(${compileNode(node.left, scope, values, sequence)} ${node.type.toUpperCase()} ${compileNode(node.right, scope, values, sequence)})`;
  if (node.type === 'not') return `(NOT (${compileNode(node.expression, scope, values, sequence)}))`;
  if (node.type === 'value') return collectionSql(scope, node.path, node.expression, values, sequence);
  const [collection, ...rest] = node.path.split('.');
  if (!scope.collection && ['emails', 'roles', 'phonenumbers', 'members', 'groups'].includes(collection!)) {
    return collectionSql(scope, collection!, { ...node, path: rest.join('.') || 'value' }, values, sequence);
  }
  return comparisonSql(column(scope, node.path), node.op, node.value, values);
}

export function compileScimFilter(value: string | undefined, kind: 'User' | 'Group'): { sql: string; bindings: unknown[] } {
  if (value === undefined) return { sql: '1', bindings: [] };
  const bindings: unknown[] = [];
  return { sql: compileNode(parseScimFilter(value), { kind, alias: 'r' }, bindings, { value: 0 }), bindings };
}

function objectValue(object: Record<string, unknown>, path: string): unknown {
  let result: unknown = object;
  for (const part of path.split('.')) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
    const key = Object.keys(result).find(key => key.toLowerCase() === part);
    if (!key) return undefined;
    result = (result as Record<string, unknown>)[key];
  }
  return result;
}

/** Used only for bounded PATCH value selectors, never to scan a database in memory. */
export function matchScimValue(node: ScimFilter, object: Record<string, unknown>, exactValue = false): boolean {
  if (node.type === 'and') return matchScimValue(node.left, object, exactValue) && matchScimValue(node.right, object, exactValue);
  if (node.type === 'or') return matchScimValue(node.left, object, exactValue) || matchScimValue(node.right, object, exactValue);
  if (node.type === 'not') return !matchScimValue(node.expression, object, exactValue);
  if (node.type === 'value') throw invalid();
  if (!['value', 'type', 'primary', 'display'].includes(node.path)) throw invalid();
  let actual = objectValue(object, node.path);
  let expected = node.value;
  if (node.op === 'pr') return actual !== undefined && actual !== null && actual !== '';
  if (node.path === 'primary' && !['eq', 'ne'].includes(node.op)) throw invalid();
  if (typeof actual === 'string' && typeof expected === 'string' && !(exactValue && node.path === 'value')) {
    actual = scimFold(actual); expected = scimFold(expected);
  }
  if (node.op === 'eq') return (actual ?? null) === expected;
  if (node.op === 'ne') return (actual ?? null) !== expected;
  if (typeof actual !== 'string' || typeof expected !== 'string') throw invalid();
  const comparisons = { co: () => actual.includes(expected), sw: () => actual.startsWith(expected), ew: () => actual.endsWith(expected),
    gt: () => actual > expected, ge: () => actual >= expected, lt: () => actual < expected, le: () => actual <= expected };
  return comparisons[node.op]();
}
