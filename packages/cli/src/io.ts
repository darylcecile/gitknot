import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import { RunnerError } from '../../runner/src/index.ts';

export interface CliIO {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export const processIO: CliIO = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr };

export async function write(stream: NodeJS.WritableStream, value: string | Uint8Array): Promise<void> {
  if (!stream.write(value)) await once(stream, 'drain');
}

export async function print(io: CliIO, value: unknown, compact = false): Promise<void> {
  await write(io.stdout, typeof value === 'string' ? `${value.replace(/\n$/, '')}\n` : `${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
}

export async function readStdin(io: CliIO, maximum = 1_048_576): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of io.stdin) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    size += data.byteLength;
    if (size > maximum) throw new RunnerError('input_limit', 'Standard input exceeds the supported byte limit.');
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readHidden(io: CliIO, prompt: string, maximum = 16_384): Promise<string> {
  if (!io.stdin.isTTY || !io.stdin.setRawMode) return (await readStdin(io, maximum)).replace(/\r?\n$/, '');
  await write(io.stderr, prompt);
  const previousRaw = io.stdin.isRaw;
  io.stdin.setRawMode(true); io.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const decoder = new StringDecoder('utf8');
    const finish = (error?: Error) => {
      io.stdin.off('data', onData); io.stdin.off('end', onEnd); io.stdin.off('error', onError);
      io.stdin.setRawMode(previousRaw); io.stdin.pause(); io.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onEnd = () => finish(new RunnerError('input_closed', 'Credential input ended before confirmation.'));
    const onError = () => finish(new RunnerError('input_failed', 'Credential input could not be read.'));
    const onData = (data: Buffer) => {
      for (const character of decoder.write(data)) {
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\x03' || character === '\x04') { finish(new RunnerError('cancelled', 'Authentication was cancelled.')); return; }
        if (character === '\x7f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ' && character !== '\x1b') value += character;
        if (Buffer.byteLength(value) > maximum) { finish(new RunnerError('input_limit', 'Credential input is too long.')); return; }
      }
    };
    io.stdin.on('data', onData); io.stdin.once('end', onEnd); io.stdin.once('error', onError);
  });
}
