import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Buffer } from 'node:buffer';
import { RunnerError } from './errors.ts';
import { decodeUtf8 } from './encoding.ts';

export function validateReport(bytes: Buffer, format: 'junit' | 'sarif' | 'json'): { failed: boolean; media_type: string } {
  const text = decodeUtf8(bytes);
  if (format === 'junit') {
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text) || XMLValidator.validate(text) !== true) throw new RunnerError('report_invalid', 'JUnit report must be well-formed XML without document types or entities.');
    let report: unknown;
    try { report = new XMLParser({ ignoreAttributes: false, processEntities: false, maxNestedTags: 64, parseTagValue: false, parseAttributeValue: false }).parse(text); }
    catch { throw new RunnerError('report_invalid', 'JUnit report could not be parsed within its limits.'); }
    if (!isRecord(report) || (!Object.hasOwn(report, 'testsuite') && !Object.hasOwn(report, 'testsuites'))) throw new RunnerError('report_invalid', 'JUnit report must have a testsuite or testsuites root.');
    return { failed: junitFailed(report), media_type: 'application/xml' };
  }
  let report: unknown;
  try { report = JSON.parse(text); } catch { throw new RunnerError('report_invalid', 'Report must contain valid JSON.'); }
  if (format === 'json') return { failed: false, media_type: 'application/json' };
  if (!isRecord(report) || report.version !== '2.1.0' || !Array.isArray(report.runs)) throw new RunnerError('report_invalid', 'SARIF report must use version 2.1.0 with a runs array.');
  const failed = report.runs.some((run: unknown) => isRecord(run) && Array.isArray(run.results) && run.results.some((result: unknown) => isRecord(result) && result.level === 'error'));
  return { failed, media_type: 'application/sarif+json' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function junitFailed(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(junitFailed);
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, 'failure') || Object.hasOwn(value, 'error')) return true;
  if (Number(value['@_failures'] ?? 0) > 0 || Number(value['@_errors'] ?? 0) > 0) return true;
  return Object.values(value).some(junitFailed);
}
