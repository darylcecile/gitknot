import { canonicalJson } from '@gitknot/core';

/** Verify the actual full bundle's advertised refs before an archive can be published. */
export function verifiedBundleStream(stream: ReadableStream<Uint8Array>, expected: readonly { ref: string; oid: string }[]): ReadableStream<Uint8Array> {
  let header = '';
  let verified = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const ordered = (refs: readonly { ref: string; oid: string }[]) => [...refs].sort((a, b) => a.ref.localeCompare(b.ref));
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!verified) {
        // The header is ASCII; binary pack bytes begin only after its blank line.
        let end = -1;
        for (let index = 0; index < chunk.byteLength; index++) {
          if (chunk[index] === 10 && (index ? chunk[index - 1] === 10 : header.endsWith('\n'))) { end = index; break; }
        }
        header += decoder.decode(end < 0 ? chunk : chunk.subarray(0, end + 1), { stream: end < 0 });
        if (header.length > 4 * 1024 * 1024) throw new Error('archive_bundle_header_limit');
        if (end >= 0) {
          const lines = header.trimEnd().split('\n');
          if (!['# v2 git bundle', '# v3 git bundle'].includes(lines.shift()!)) throw new Error('archive_bundle_format');
          const refs: { ref: string; oid: string }[] = [];
          for (const line of lines) {
            if (/^@object-format=(?:sha1|sha256)$/.test(line)) continue;
            const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (refs\/[^\s]+)$/.exec(line);
            if (!match) throw new Error('archive_bundle_incomplete');
            refs.push({ oid: match[1]!, ref: match[2]! });
          }
          if (canonicalJson(ordered(refs)) !== canonicalJson(ordered(expected))) throw new Error('archive_bundle_ref_mismatch');
          verified = true; header = '';
        }
      }
      controller.enqueue(chunk);
    },
    flush() { if (!verified) throw new Error('archive_bundle_header_missing'); },
  }));
}
