const { execFileSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The hosted profile requires Linux/amd64.');
const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
const git = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim().replace(/^git version /, '');
const tools = { node: process.versions.node, npm, git };
if (!Object.values(tools).every(value => /^\d+\.\d+\.\d+(?:[-.+][A-Za-z0-9.-]+)?$/.test(value))) throw new Error('Toolchain versions must be exact.');
writeFileSync('/opt/gitknot/toolchain.json', JSON.stringify({ os: 'linux', arch: 'x64', sandbox_version: '0.12.1', tools }), { mode: 0o444 });
