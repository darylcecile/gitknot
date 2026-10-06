import { mkdir, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeGit } from './process.ts';
import type { SignatureTrust } from '../../../packages/git/src/types.ts';
import type { ObjectInfo } from './objects.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

const execute = promisify(execFile);

export class SignatureVerifier {
  private readonly git: NativeGit;
  private readonly trust: SignatureTrust;
  private initialized = false;
  private readonly ssh: string;
  private readonly gpgHome: string;
  private readonly gpgProgram: string;

  constructor(git: NativeGit, trust: SignatureTrust) {
    this.git = git;
    this.trust = trust;
    this.ssh = join(git.directory, 'gitknot-allowed-signers');
    this.gpgHome = join(git.directory, 'gitknot-gnupg');
    this.gpgProgram = join(git.directory, 'gitknot-gpg');
  }

  async verify(info: ObjectInfo, raw: Buffer): Promise<void> {
    await this.initialize();
    const command = info.type === 'commit' ? 'verify-commit' : 'verify-tag';
    const ssh = raw.includes(Buffer.from('-----BEGIN SSH SIGNATURE-----'));
    const pgp = raw.includes(Buffer.from('-----BEGIN PGP SIGNATURE-----'));
    requireValue(ssh || pgp, 'signature_required', 'Repository policy requires a verified object signature.');
    const config = ssh ? [
      'gpg.format=ssh', `gpg.ssh.allowedSignersFile=${this.ssh}`, 'gpg.ssh.program=/usr/bin/ssh-keygen',
    ] : ['gpg.format=openpgp', `gpg.program=${this.gpgProgram}`];
    const result = await this.git.run([command, '--raw', info.oid], { config, allow_failure: true });
    requireValue(result.code === 0, 'signature_invalid', 'A required Git signature is missing, invalid, expired, or untrusted.');
    if (!ssh) {
      const status = result.stderr.toString();
      const valid = /^\[GNUPG:\] VALIDSIG ([A-Fa-f0-9]+) .+$/mu.exec(status);
      const fields = valid?.[0].split(' ') ?? [];
      const fingerprints = [valid?.[1], fields.at(-1)].filter(Boolean).map(value => value!.toUpperCase());
      requireValue(valid && !/\[GNUPG:\] (?:EXPKEYSIG|REVKEYSIG|EXPSIG|KEYEXPIRED|KEYREVOKED|BADSIG)/u.test(status)
        && this.trust.openpgp_fingerprints.some(fingerprint => fingerprints.includes(fingerprint.toUpperCase())),
      'signature_untrusted', 'The signature is not made by a currently trusted signing key.');
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    requireValue(this.trust.ssh_signers.length <= 1000 && this.trust.openpgp_keys.length <= 100, 'signature_configuration', 'Signing trust exceeds its configured limit.', 503);
    for (const signer of this.trust.ssh_signers) {
      requireValue(/^[\w@.*,+-]+ (?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/u.test(signer),
        'signature_configuration', 'A trusted SSH signing key is invalid.', 503);
    }
    await writeFile(this.ssh, this.trust.ssh_signers.join('\n') + '\n', { mode: 0o600 });
    await mkdir(this.gpgHome, { mode: 0o700 });
    requireValue(!/[\r\n'\\]/u.test(this.gpgHome), 'signature_configuration', 'Invalid signing trust directory.', 503);
    await writeFile(this.gpgProgram,
      `#!/bin/sh\nexec /usr/bin/gpg --batch --no-auto-key-retrieve --no-auto-key-import --no-autostart --homedir '${this.gpgHome}' "$@"\n`, { mode: 0o700 });
    if (this.trust.openpgp_keys.length) {
      const path = join(this.gpgHome, 'trusted.asc');
      const keys = this.trust.openpgp_keys.join('\n');
      requireValue(Buffer.byteLength(keys) <= 1024 * 1024, 'signature_configuration', 'Signing trust exceeds its byte limit.', 503);
      await writeFile(path, keys, { mode: 0o600 });
      await execute('/usr/bin/gpg', ['--batch', '--no-autostart', '--homedir', this.gpgHome, '--import', path], {
        env: { PATH: '/usr/bin:/bin', HOME: this.gpgHome }, timeout: Math.max(1, this.git.deadline - Date.now()), maxBuffer: 64 * 1024,
      });
    }
    this.initialized = true;
  }
}
