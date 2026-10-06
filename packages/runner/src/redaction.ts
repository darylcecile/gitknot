import { Buffer } from 'node:buffer';

const MASK = '[REDACTED]';

export function secretVariants(values: Iterable<string>): string[] {
  const variants = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    variants.add(value);
    variants.add(encodeURIComponent(value));
    variants.add(JSON.stringify(value).slice(1, -1));
    variants.add(Buffer.from(value).toString('base64'));
    variants.add(Buffer.from(value).toString('base64url'));
  }
  return [...variants].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/** Holds an undecidable suffix so a secret split over arbitrary stream chunks never escapes. */
export class SecretRedactor {
  private pending = '';
  private secrets: string[] = [];
  private width = 1;
  private prefixes: Int32Array[] = [];

  constructor(values: Iterable<string> = []) { this.add(values); }

  add(values: Iterable<string>): void {
    this.secrets = [...new Set([...this.secrets, ...secretVariants(values)])].sort((a, b) => b.length - a.length || a.localeCompare(b));
    this.width = Math.max(1, ...this.secrets.map((value) => value.length));
    this.prefixes = this.secrets.map((secret) => {
      const prefix = new Int32Array(secret.length);
      for (let index = 1, matched = 0; index < secret.length; index += 1) {
        while (matched > 0 && secret[index] !== secret[matched]) matched = prefix[matched - 1]!;
        if (secret[index] === secret[matched]) matched += 1;
        prefix[index] = matched;
      }
      return prefix;
    });
  }

  write(value: string): string {
    this.pending += value;
    return this.consume(false);
  }

  finish(): string { return this.consume(true); }

  private consume(final: boolean): string {
    let index = 0;
    const end = final ? this.pending.length : this.safeBoundary();
    let result = '';
    while (index < end) {
      let start = end;
      let matched = '';
      for (const secret of this.secrets) {
        const found = this.pending.indexOf(secret, index);
        if (found >= 0 && found < start) { start = found; matched = secret; }
      }
      result += this.pending.slice(index, start);
      if (matched) { result += MASK; index = start + matched.length; }
      else index = end;
    }
    this.pending = this.pending.slice(index);
    return result;
  }

  private safeBoundary(): number {
    let undecided = 0;
    const start = Math.max(0, this.pending.length - this.width + 1);
    for (const [index, secret] of this.secrets.entries()) {
      const prefix = this.prefixes[index]!;
      let matched = 0;
      for (let position = start; position < this.pending.length; position += 1) {
        while (matched > 0 && this.pending[position] !== secret[matched]) matched = prefix[matched - 1]!;
        if (this.pending[position] === secret[matched]) matched += 1;
        if (matched === secret.length) matched = prefix[matched - 1]!;
      }
      undecided = Math.max(undecided, matched);
    }
    return this.pending.length - undecided;
  }
}

export function redactText(value: string, secrets: Iterable<string>): string {
  const redactor = new SecretRedactor(secrets);
  return redactor.write(value) + redactor.finish();
}

export function containsSecret(bytes: Uint8Array, secrets: Iterable<string>): boolean {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return secretVariants(secrets).some((secret) => buffer.includes(Buffer.from(secret)));
}
