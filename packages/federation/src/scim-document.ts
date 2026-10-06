import { z } from 'zod';
import { ScimError } from './errors.ts';
import { matchScimValue, normalizeAttributePath, parseScimFilter, scimFold } from './scim-filter.ts';
import { SCIM_ENTERPRISE_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_PATCH_SCHEMA, SCIM_USER_SCHEMA } from './types.ts';
import type { ScimObject } from './types.ts';

const names = ['schemas', 'id', 'externalId', 'meta', 'resourceType', 'created', 'lastModified', 'version', 'location',
  'userName', 'displayName', 'name', 'formatted', 'givenName', 'familyName', 'middleName', 'honorificPrefix', 'honorificSuffix',
  'nickName', 'title', 'userType', 'preferredLanguage', 'locale', 'timezone', 'emails', 'phoneNumbers', 'roles', 'groups', 'members',
  'active', 'value', 'type', 'primary', 'display', '$ref', 'employeeNumber', 'costCenter', 'organization', 'division', 'department',
  'manager', 'password', 'Operations', 'op', 'path', 'filter', 'startIndex', 'count', 'attributes', 'excludedAttributes', SCIM_ENTERPRISE_SCHEMA];
const canonicalNames = new Map(names.map(value => [value.toLowerCase(), value]));
const optionalText = z.string().max(512).regex(/^[^\x00-\x1f\x7f]*$/);
const requiredText = optionalText.min(1);
const multiple = z.object({ value: requiredText, type: optionalText.optional(), display: optionalText.optional(), primary: z.boolean().optional() });
const emails = z.array(multiple.extend({ value: z.email().max(254) })).max(20);
const name = z.object(Object.fromEntries(['formatted', 'givenName', 'familyName', 'middleName', 'honorificPrefix', 'honorificSuffix'].map(key => [key, optionalText.optional()])));
const enterprise = z.object({ employeeNumber: optionalText.optional(), costCenter: optionalText.optional(), organization: optionalText.optional(),
  division: optionalText.optional(), department: optionalText.optional(), manager: z.object({ value: requiredText, displayName: optionalText.optional(), $ref: optionalText.optional() }).optional() });
const userSchema = z.object({
  schemas: z.array(z.enum([SCIM_USER_SCHEMA, SCIM_ENTERPRISE_SCHEMA])).min(1).max(2),
  externalId: requiredText, userName: requiredText.max(256), active: z.boolean().default(true),
  displayName: optionalText.max(256).optional(), name: name.optional(), nickName: optionalText.optional(), title: optionalText.optional(),
  userType: optionalText.optional(), preferredLanguage: optionalText.optional(), locale: optionalText.optional(), timezone: optionalText.optional(),
  emails: emails.optional(), phoneNumbers: z.array(multiple).max(20).optional(), roles: z.array(multiple).max(64).optional(),
  [SCIM_ENTERPRISE_SCHEMA]: enterprise.optional(),
});
const memberSchema = z.object({ value: z.string().regex(/^su_[\w-]{8,100}$/), display: optionalText.optional(),
  type: z.string().refine(value => value.toLowerCase() === 'user').optional(), $ref: z.string().max(2048).optional() });
const groupSchema = z.object({ schemas: z.array(z.literal(SCIM_GROUP_SCHEMA)).length(1), externalId: requiredText,
  displayName: requiredText.max(256), members: z.array(memberSchema).max(1000).default([]) });
const patchSchema = z.object({ schemas: z.array(z.literal(SCIM_PATCH_SCHEMA)).length(1),
  Operations: z.array(z.object({ op: z.string().transform(value => value.toLowerCase()).pipe(z.enum(['add', 'replace', 'remove'])),
    path: z.string().min(1).max(2048).optional(), value: z.unknown().optional() })).min(1).max(100) });

export type ScimUser = z.infer<typeof userSchema>;
export type ScimGroup = z.infer<typeof groupSchema>;
type PatchOperation = z.infer<typeof patchSchema>['Operations'][number];

export function scimInputJsonSchema(kind: 'User' | 'Group' | 'Patch'): Record<string, unknown> {
  const schema = kind === 'User' ? userSchema : kind === 'Group' ? groupSchema : patchSchema;
  const { $schema, ...document } = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  void $schema;
  return document;
}

/** SCIM attribute names are case-insensitive. Ambiguous duplicate spellings are rejected. */
export function canonicalScimInput(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new ScimError(400, 'The SCIM document is too deeply nested.', 'invalidSyntax');
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new ScimError(400, 'The SCIM collection is too large.', 'tooMany');
    return value.map(item => canonicalScimInput(item, depth + 1));
  }
  if (value === null || typeof value !== 'object') return value;
  const result: ScimObject = Object.create(null) as ScimObject;
  if (Object.keys(value).length > 100) throw new ScimError(400, 'The SCIM object has too many attributes.', 'invalidSyntax');
  for (const [key, entry] of Object.entries(value)) {
    const canonical = canonicalNames.get(key.toLowerCase()) ?? key;
    if (['__proto__', 'prototype', 'constructor'].includes(key) || Object.hasOwn(result, canonical)) throw new ScimError(400, 'The SCIM object contains ambiguous attributes.', 'invalidSyntax');
    result[canonical] = canonicalScimInput(entry, depth + 1);
  }
  return result;
}

function objectInput(raw: unknown): ScimObject {
  const value = canonicalScimInput(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScimError(400, 'A SCIM JSON object is required.', 'invalidSyntax');
  const result = value as ScimObject;
  if (Object.hasOwn(result, 'password')) throw new ScimError(400, 'SCIM cannot set or change GitKnot authentication credentials.', 'mutability');
  return result;
}

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== null).map(([key, value]) => [key, withoutNulls(value)]));
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ScimError(400, 'The SCIM document does not match the supported resource schema. Check required fields, field types, and collection limits.', 'invalidValue');
  return result.data;
}

function primaryValues(value: { primary?: boolean }[] | undefined): void {
  if (value && value.filter(item => item.primary).length > 1) throw new ScimError(400, 'A multi-valued attribute can have only one primary value.', 'invalidValue');
}

export function parseScimUser(raw: unknown, previous?: ScimUser): ScimUser {
  const value = objectInput(raw);
  if (value[SCIM_ENTERPRISE_SCHEMA] && Array.isArray(value.schemas) && !value.schemas.includes(SCIM_ENTERPRISE_SCHEMA)) value.schemas = [...value.schemas, SCIM_ENTERPRISE_SCHEMA];
  if (previous && value.externalId === undefined) value.externalId = previous.externalId;
  const user = parse(userSchema, withoutNulls(value));
  if (!user.schemas.includes(SCIM_USER_SCHEMA) || new Set(user.schemas).size !== user.schemas.length) throw new ScimError(400, 'The core User schema is required exactly once.', 'invalidValue');
  if (previous && user.externalId !== previous.externalId) throw new ScimError(400, 'externalId is immutable after provisioning.', 'mutability');
  for (const array of [user.emails, user.phoneNumbers, user.roles]) primaryValues(array);
  return user;
}

export function parseScimGroup(raw: unknown, previous?: ScimGroup): ScimGroup {
  const value = objectInput(raw);
  if (previous && value.externalId === undefined) value.externalId = previous.externalId;
  const group = parse(groupSchema, withoutNulls(value));
  if (previous && group.externalId !== previous.externalId) throw new ScimError(400, 'externalId is immutable after provisioning.', 'mutability');
  group.members = [...new Map(group.members.map(member => [member.value, member])).values()];
  return group;
}

export function scimManagedEmail(user: ScimUser): string {
  const email = user.emails?.find(value => value.primary)?.value ?? user.emails?.[0]?.value ?? user.userName;
  if (!z.email().safeParse(email).success) throw new ScimError(400, 'Provide a work email in emails or use an email address as userName.', 'invalidValue');
  return email;
}

export function scimSearchDocument(value: unknown): unknown {
  if (typeof value === 'string') return scimFold(value);
  if (Array.isArray(value)) return value.map(scimSearchDocument);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scimSearchDocument(entry)]));
}

const userWritable = new Set(['externalId', 'userName', 'active', 'displayName', 'name', 'nickName', 'title', 'userType',
  'preferredLanguage', 'locale', 'timezone', 'emails', 'phoneNumbers', 'roles', SCIM_ENTERPRISE_SCHEMA]);
const groupWritable = new Set(['externalId', 'displayName', 'members']);
const multiAttributes = new Set(['emails', 'phoneNumbers', 'roles', 'members']);
const readOnly = new Set(['id', 'meta', 'groups', 'password']);

function assertWritable(key: string, kind: 'User' | 'Group'): void {
  if (readOnly.has(key)) throw new ScimError(400, 'The selected attribute is read-only.', 'mutability');
  if (!(kind === 'User' ? userWritable : groupWritable).has(key)) throw new ScimError(400, 'The PATCH path is not supported by this resource schema.', 'invalidPath');
}

function mergeObject(current: unknown, added: unknown): unknown {
  if (!current || typeof current !== 'object' || Array.isArray(current) || !added || typeof added !== 'object' || Array.isArray(added)) return added;
  return { ...current, ...added };
}

function deduplicate(array: unknown[], key: string): unknown[] {
  if (!array.every(item => item && typeof item === 'object' && typeof (item as ScimObject).value === 'string')) return array;
  return [...new Map(array.map(item => {
    const value = (item as { value: string }).value;
    return [key === 'members' ? value : scimFold(value), item];
  })).values()];
}

function applyRoot(document: ScimObject, key: string, operation: PatchOperation, kind: 'User' | 'Group'): void {
  assertWritable(key, kind);
  if (key === 'externalId') {
    if (operation.op === 'remove' || operation.value !== document.externalId) throw new ScimError(400, 'externalId is immutable after provisioning.', 'mutability');
    return;
  }
  if (operation.op === 'remove') {
    if (key === 'members' && operation.value !== undefined) {
      const values = Array.isArray(operation.value) ? operation.value : [operation.value];
      const removed = new Set(values.map(value => (value as ScimObject)?.value));
      if (removed.has(undefined)) throw new ScimError(400, 'Member removal requires member value IDs.', 'invalidValue');
      document.members = ((document.members as ScimObject[]) ?? []).filter(member => !removed.has(member.value));
    } else delete document[key];
    return;
  }
  if (operation.value === undefined) throw new ScimError(400, 'A PATCH add or replace operation requires value.', 'invalidSyntax');
  if (multiAttributes.has(key)) {
    const value = Array.isArray(operation.value) ? operation.value : [operation.value];
    document[key] = deduplicate(operation.op === 'add' ? [...(Array.isArray(document[key]) ? document[key] : []), ...value] : value, key);
  } else document[key] = operation.op === 'add' ? mergeObject(document[key], operation.value) : operation.value;
}

function patchPath(path: string): { key: string; sub?: string; selector?: string } {
  const normalized = normalizeAttributePath(path);
  const match = /^([a-z][a-z0-9_-]*)(?:\[(.+)\])?(?:\.([a-z][a-z0-9_-]*))?$/.exec(normalized);
  if (!match) throw new ScimError(400, 'The PATCH attribute path is invalid.', 'invalidPath');
  // Attribute names are case-insensitive; filter string literals must retain their original case.
  const start = path.indexOf('[');
  const end = path.lastIndexOf(']');
  return { key: match[1] === 'enterprise' ? SCIM_ENTERPRISE_SCHEMA : canonicalNames.get(match[1]!) ?? match[1]!,
    ...(match[3] ? { sub: canonicalNames.get(match[3]) ?? match[3] } : {}),
    ...(start >= 0 && end > start ? { selector: path.slice(start + 1, end) } : {}) };
}

function assertSubAttribute(key: string, sub: string): void {
  const allowed: Record<string, string[]> = {
    name: ['formatted', 'givenName', 'familyName', 'middleName', 'honorificPrefix', 'honorificSuffix'],
    emails: ['value', 'type', 'display', 'primary'], phoneNumbers: ['value', 'type', 'display', 'primary'], roles: ['value', 'type', 'display', 'primary'],
    members: ['value', 'type', 'display', '$ref'],
    [SCIM_ENTERPRISE_SCHEMA]: ['employeeNumber', 'costCenter', 'organization', 'division', 'department', 'manager'],
  };
  if (!allowed[key]?.includes(sub)) throw new ScimError(400, 'The PATCH sub-attribute is not supported by this resource schema.', 'invalidPath');
}

function applyPath(document: ScimObject, operation: PatchOperation, kind: 'User' | 'Group'): void {
  const { key, sub, selector } = patchPath(operation.path!);
  assertWritable(key, kind);
  if (sub) assertSubAttribute(key, sub);
  if (!selector && !sub) { applyRoot(document, key, operation, kind); return; }
  if (key === 'externalId') throw new ScimError(400, 'externalId is immutable.', 'mutability');
  if (!selector) {
    if (multiAttributes.has(key)) {
      const array = Array.isArray(document[key]) ? document[key] as ScimObject[] : [];
      if (!array.length) throw new ScimError(400, 'The PATCH sub-attribute has no target.', 'noTarget');
      document[key] = array.map(value => patchSubAttribute(value, sub!, operation));
    } else {
      const object = document[key] && typeof document[key] === 'object' ? document[key] as ScimObject : {};
      document[key] = patchSubAttribute(object, sub!, operation);
    }
    return;
  }
  if (!multiAttributes.has(key)) throw new ScimError(400, 'Value filters require a multi-valued attribute.', 'invalidPath');
  const expression = parseScimFilter(selector);
  const array = Array.isArray(document[key]) ? document[key] as ScimObject[] : [];
  const matches = array.map(value => matchScimValue(expression, value, key === 'members'));
  if (!matches.some(Boolean)) throw new ScimError(400, 'The PATCH value filter did not match a target.', 'noTarget');
  document[key] = array.flatMap((value, index) => {
    if (!matches[index]) return [value];
    if (sub) return [patchSubAttribute(value, sub, operation)];
    if (operation.op === 'remove') return [];
    if (!operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) throw new ScimError(400, 'A selected complex value requires an object.', 'invalidValue');
    return [operation.op === 'add' ? mergeObject(value, operation.value) : operation.value];
  });
}

function patchSubAttribute(value: ScimObject, key: string, operation: PatchOperation): ScimObject {
  const result = { ...value };
  if (operation.op === 'remove') delete result[key];
  else {
    if (operation.value === undefined) throw new ScimError(400, 'The PATCH operation requires value.', 'invalidSyntax');
    result[key] = operation.value;
  }
  return result;
}

/** RFC 7644 §3.5.2: promoting a primary value clears the previous primary immediately. */
function normalizePatchPrimaries(before: ScimObject, after: ScimObject): void {
  for (const key of ['emails', 'phoneNumbers', 'roles']) {
    const current = after[key];
    if (!Array.isArray(current)) continue;
    const previous = Array.isArray(before[key]) ? before[key] as ScimObject[] : [];
    const primary = current.filter((value): value is ScimObject => !!value && typeof value === 'object' && value.primary === true);
    const promoted = primary.filter(value => !previous.some(old => old?.primary === true && old.value === value.value));
    if (promoted.length > 1 || (!promoted.length && primary.length > 1)) {
      throw new ScimError(400, 'A PATCH operation may promote only one primary value per collection.', 'invalidValue');
    }
    if (promoted.length === 1) {
      for (const value of current) {
        if (value && typeof value === 'object' && value !== promoted[0]) value.primary = false;
      }
    }
  }
}

export function applyScimPatch(previous: ScimObject, raw: unknown, kind: 'User' | 'Group'): ScimObject {
  const patch = parse(patchSchema, objectInput(raw));
  const result = structuredClone(previous);
  for (const operation of patch.Operations) {
    const before = structuredClone(result);
    if (operation.path) applyPath(result, operation, kind);
    else {
      if (operation.op === 'remove' || !operation.value || typeof operation.value !== 'object' || Array.isArray(operation.value)) {
        throw new ScimError(400, 'PATCH operations without a path require an object value; remove requires a path.', 'invalidSyntax');
      }
      for (const [key, value] of Object.entries(operation.value)) applyRoot(result, key, { ...operation, value }, kind);
    }
    normalizePatchPrimaries(before, result);
  }
  return result;
}

function projectSubAttributes(value: unknown, names: ReadonlySet<string>, exclude: boolean): unknown {
  if (Array.isArray(value)) return value.map(entry => projectSubAttributes(entry, names, exclude));
  if (!value || typeof value !== 'object') return exclude ? value : undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => exclude ? !names.has(key) : names.has(key)));
}

/** SCIM response projection preserves always-returned identity/schema fields. */
export function projectScimResource(resource: ScimObject, attributes?: string, excluded?: string): ScimObject {
  if (attributes && excluded) throw new ScimError(400, 'Use attributes or excludedAttributes, not both.', 'invalidValue');
  const source = attributes ?? excluded;
  if (!source) return resource;
  if (source.length > 2048) throw new ScimError(400, 'The attribute projection is too large.', 'invalidValue');
  const paths = source.split(',').map(value => patchPath(value.trim()));
  if (paths.length > 64 || paths.some(value => value.selector)) throw new ScimError(400, 'The attribute projection is invalid.', 'invalidPath');
  const selected = new Map<string, { all: boolean; children: Set<string> }>();
  for (const { key, sub } of paths) {
    const selection = selected.get(key) ?? { all: false, children: new Set<string>() };
    if (sub) selection.children.add(sub); else selection.all = true;
    selected.set(key, selection);
  }
  const result: ScimObject = attributes ? { id: resource.id, schemas: resource.schemas } : structuredClone(resource);
  for (const [key, selection] of selected) {
    if (['id', 'schemas'].includes(key) || !Object.hasOwn(resource, key)) continue;
    if (attributes) {
      result[key] = selection.all ? structuredClone(resource[key]) : projectSubAttributes(resource[key], selection.children, false);
    } else if (selection.all) delete result[key];
    else result[key] = projectSubAttributes(result[key], selection.children, true);
  }
  return result;
}
