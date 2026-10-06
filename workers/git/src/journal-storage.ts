import type { JournalStorage } from '../../../packages/git/src/journal.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

interface DocumentHeader { encoding: 'git-json-chunks-v1'; chunks: number; bytes: number }
type Storage = DurableObjectStorage | DurableObjectTransaction;
const chunkBytes = 64 * 1024;

/** SQLite-backed DO KV values are bounded; a large graph is one atomic, chunked document. */
export function journalStorage(storage: Storage): JournalStorage {
  const adapter: JournalStorage = {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await storage.get<T | DocumentHeader>(key);
      if (!isHeader(value)) return value as T | undefined;
      requireValue(value.bytes <= 8 * 1024 * 1024 && value.chunks === Math.ceil(value.bytes / chunkBytes), 'journal_corrupt', 'Git publication journal metadata is invalid.', 503);
      const data = new Uint8Array(value.bytes);
      for (let index = 0; index < value.chunks; index++) {
        const part = await storage.get<Uint8Array>(partKey(key, index));
        requireValue(part && part.byteLength === Math.min(chunkBytes, value.bytes - index * chunkBytes), 'journal_corrupt', 'Git publication journal data is incomplete.', 503);
        data.set(part, index * chunkBytes);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as T;
    },
    async put<T>(key: string, value: T): Promise<void> {
      const prior = await storage.get<unknown>(key);
      const data = new TextEncoder().encode(JSON.stringify(value));
      requireValue(data.length <= 8 * 1024 * 1024, 'journal_limit', 'Git publication journal exceeded its metadata limit.', 413);
      const count = Math.ceil(data.length / chunkBytes);
      for (let index = 0; index < count; index++) await storage.put(partKey(key, index), data.slice(index * chunkBytes, (index + 1) * chunkBytes));
      if (isHeader(prior)) for (let index = count; index < prior.chunks; index++) await storage.delete(partKey(key, index));
      await storage.put(key, { encoding: 'git-json-chunks-v1', chunks: count, bytes: data.length } satisfies DocumentHeader);
    },
    async delete(key: string): Promise<void> {
      const prior = await storage.get<unknown>(key);
      if (isHeader(prior)) for (let index = 0; index < prior.chunks; index++) await storage.delete(partKey(key, index));
      await storage.delete(key);
    },
    async transaction<T>(callback: (tx: JournalStorage) => Promise<T>): Promise<T> {
      if ('transaction' in storage) return storage.transaction(tx => callback(journalStorage(tx)));
      return callback(adapter);
    },
  };
  return adapter;
}

function partKey(key: string, index: number): string { return `${key}:part:${String(index).padStart(4, '0')}`; }
function isHeader(value: unknown): value is DocumentHeader {
  return !!value && typeof value === 'object' && 'encoding' in value && value.encoding === 'git-json-chunks-v1';
}
