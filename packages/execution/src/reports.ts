import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ApiError } from '@gitknot/core';

export function reportFailed(bytes: Uint8Array, format: string): boolean {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (format === 'junit') {
    if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text) || XMLValidator.validate(text) !== true) throw new ApiError(422, 'report_invalid', 'JUnit reports must be well-formed XML without entities or document types.');
    let report: unknown;
    try { report = new XMLParser({ ignoreAttributes: false, processEntities: false, maxNestedTags: 64, parseTagValue: false, parseAttributeValue: false }).parse(text); }
    catch { throw new ApiError(422, 'report_invalid', 'The JUnit report exceeds supported parsing limits.'); }
    if (!record(report) || !('testsuite' in report || 'testsuites' in report)) throw new ApiError(422, 'report_invalid', 'JUnit reports require a testsuite root.');
    return failedXml(report);
  }
  let report: unknown;
  try { report = JSON.parse(text); } catch { throw new ApiError(422, 'report_invalid', 'The report must contain valid JSON.'); }
  if (format === 'json') return false;
  if (format !== 'sarif' || !record(report) || report.version !== '2.1.0' || !Array.isArray(report.runs)) throw new ApiError(422, 'report_invalid', 'SARIF reports require version 2.1.0 and a runs array.');
  return report.runs.some(run => record(run) && Array.isArray(run.results) && run.results.some(value => record(value) && value.level === 'error'));
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function failedXml(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(failedXml);
  if (!record(value)) return false;
  if (Object.hasOwn(value, 'failure') || Object.hasOwn(value, 'error') || Number(value['@_failures'] ?? 0) > 0 || Number(value['@_errors'] ?? 0) > 0) return true;
  return Object.values(value).some(failedXml);
}
