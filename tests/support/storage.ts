import { createHash } from 'node:crypto';

interface Stored {
  bytes: Uint8Array<ArrayBuffer>;
  options: R2PutOptions;
  uploaded: Date;
  etag: string;
}

async function read(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null): Promise<Uint8Array<ArrayBuffer>> {
  if (value === null) return new Uint8Array();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
}

export class TestBucket {
  readonly objects = new Map<string, Stored>();

  private metadata(key: string, stored: Stored): R2Object {
    const digest = createHash('sha256').update(stored.bytes).digest();
    const digestHex = createHash('sha256').update(stored.bytes).digest('hex');
    return {
      key, version: stored.etag, size: stored.bytes.byteLength, etag: stored.etag, httpEtag: `"${stored.etag}"`,
      uploaded: stored.uploaded, checksums: { sha256: new Uint8Array(digest).buffer, toJSON: () => ({ sha256: digestHex }) },
      storageClass: 'Standard', customMetadata: stored.options.customMetadata ?? {}, httpMetadata: stored.options.httpMetadata ?? {},
      writeHttpMetadata(headers: Headers) {
        const metadata = stored.options.httpMetadata;
        if (metadata && !(metadata instanceof Headers)) {
          if (metadata.contentType) headers.set('content-type', metadata.contentType);
          if (metadata.contentDisposition) headers.set('content-disposition', metadata.contentDisposition);
        }
      },
    } as R2Object;
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    return stored ? this.metadata(key, stored) : null;
  }

  async get(key: string, options: R2GetOptions = {}): Promise<R2ObjectBody | R2Object | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const metadata = this.metadata(key, stored);
    const condition = options.onlyIf as R2Conditional | undefined;
    if (condition?.etagDoesNotMatch === stored.etag || (condition?.etagMatches && condition.etagMatches !== stored.etag)) return metadata;
    let content = stored.bytes;
    const range = options.range as { offset?: number; length?: number; suffix?: number } | undefined;
    if (range?.suffix) content = content.slice(-range.suffix);
    else if (range) content = content.slice(range.offset ?? 0, range.length === undefined ? undefined : (range.offset ?? 0) + range.length);
    const response = new Response(new Uint8Array(content));
    return Object.assign(metadata, {
      body: response.body!, bodyUsed: false, range,
      arrayBuffer: () => response.arrayBuffer(), text: () => response.text(), json: () => response.json(), blob: () => response.blob(),
    }) as R2ObjectBody;
  }

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null, options: R2PutOptions = {}): Promise<R2Object | null> {
    const condition = options.onlyIf as R2Conditional | undefined;
    const content = await read(value);
    const digest = createHash('sha256').update(content).digest('hex');
    if (options.sha256) {
      const expected = typeof options.sha256 === 'string' ? options.sha256 : Buffer.from(options.sha256).toString('hex');
      if (expected !== digest) throw new Error('R2 checksum mismatch');
    }
    const existing = this.objects.get(key);
    if (existing && (condition?.etagDoesNotMatch === '*' || condition?.etagDoesNotMatch === existing.etag)) return null;
    if (condition?.etagMatches && condition.etagMatches !== existing?.etag) return null;
    const stored = { bytes: content, options, uploaded: new Date(), etag: digest };
    this.objects.set(key, stored);
    return this.metadata(key, stored);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(options.prefix ?? '') && key > (options.cursor ?? '')).sort();
    const limit = options.limit ?? 1000;
    const selected = keys.slice(0, limit);
    return {
      objects: selected.map(key => this.metadata(key, this.objects.get(key)!)), truncated: keys.length > limit,
      delimitedPrefixes: [], ...(keys.length > limit ? { cursor: selected.at(-1)! } : {}),
    } as R2Objects;
  }

  binding(): R2Bucket { return this as unknown as R2Bucket; }
}

export class TestQueue<T = unknown> {
  readonly messages: T[] = [];
  async send(body: T): Promise<void> { this.messages.push(structuredClone(body)); }
  async sendBatch(messages: { body: T }[]): Promise<void> { for (const message of messages) await this.send(message.body); }
  binding(): Queue<T> { return this as unknown as Queue<T>; }
}
