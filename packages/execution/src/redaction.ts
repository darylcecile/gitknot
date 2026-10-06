import { ApiError } from '@gitknot/core';
import { EXECUTION_LIMITS } from './config.ts';

const marker = '[REDACTED]';

export function secretVariants(values: string[]): string[] {
  const variants = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (new TextEncoder().encode(value).length > EXECUTION_LIMITS.max_secret_bytes) throw new ApiError(422, 'secret_too_large', 'A declared secret exceeds the redaction limit.');
    variants.add(value);
    variants.add(encodeURIComponent(value));
    variants.add(JSON.stringify(value).slice(1, -1));
    let binary = '';
    for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
    variants.add(btoa(binary));
  }
  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** Bounded carry preserves matches split across arbitrary network/file chunks. */
export class StreamingRedactor {
  private pending = '';
  private readonly values: string[];
  private readonly carry: number;
  private readonly decoder = new TextDecoder('utf-8');
  private readonly encoder = new TextEncoder();

  constructor(values: string[]) {
    this.values = secretVariants(values);
    this.carry = Math.max(1, ...this.values.map(value => value.length)) - 1;
  }

  push(bytes: Uint8Array, final = false): Uint8Array {
    this.pending += this.decoder.decode(bytes, { stream: !final });
    let boundary = final ? this.pending.length : Math.max(0, this.pending.length - this.carry);
    // Do not split a known match across the emitted prefix and retained suffix.
    for (const value of this.values) {
      let index = this.pending.indexOf(value);
      while (index !== -1 && index < boundary) {
        if (index + value.length > boundary) boundary = index;
        index = this.pending.indexOf(value, index + 1);
      }
    }
    if (boundary > 0 && boundary < this.pending.length && /[\uD800-\uDBFF]/.test(this.pending[boundary - 1]!) && /[\uDC00-\uDFFF]/.test(this.pending[boundary]!)) boundary--;
    let output = this.pending.slice(0, boundary);
    this.pending = this.pending.slice(boundary);
    for (const value of this.values) output = output.split(value).join(marker);
    return this.encoder.encode(output);
  }

  finish(): Uint8Array { return this.push(new Uint8Array(), true); }
}

export function redactText(value: string, secrets: string[]): string {
  const redactor = new StreamingRedactor(secrets);
  return new TextDecoder().decode(redactor.push(new TextEncoder().encode(value), true));
}

export function redactedStream(source: ReadableStream<Uint8Array>, values: string[]): ReadableStream<Uint8Array> {
  const redactor = new StreamingRedactor(values);
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { const value = redactor.push(chunk); if (value.length) controller.enqueue(value); },
    flush(controller) { const value = redactor.finish(); if (value.length) controller.enqueue(value); },
  }));
}
