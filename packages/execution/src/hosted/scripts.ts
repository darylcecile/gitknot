import type { PlanStep } from '../types.ts';

// Root-only script generation must not load control-plane authorization modules.
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export const HOSTED_UID = 10000;
export const CONTROL_DIR = '/tmp/gitknot-control';
export const SNAPSHOT_DIR = '/tmp/gitknot-snapshot';

export function jobProcessScript(step: PlanStep, index: number, timeoutMs: number, maximumLogBytes: number): string {
  if (!['sh', 'bash'].includes(step.shell)) throw new Error('The hosted Linux profile does not provide the requested shell.');
  const script = `${CONTROL_DIR}/step-${index}.sh`;
  const seconds = Math.max(1, Math.floor(timeoutMs / 1000));
  const body = [
    'set -eu',
    `ulimit -H -S -f ${Math.ceil(maximumLogBytes / 1024)}`,
    'ulimit -H -S -n 1024',
    'ulimit -H -S -u 256',
    `exec setsid sh -c ${shellQuote([
      `echo $$ > ${CONTROL_DIR}/pgid`,
      `exec timeout --signal=TERM --kill-after=5s ${seconds}s setpriv --reuid=${HOSTED_UID} --regid=${HOSTED_UID} --clear-groups --no-new-privs --bounding-set=-all ${step.shell} ${shellQuote(script)}`,
    ].join('\n'))} > ${CONTROL_DIR}/step-${index}.out 2> ${CONTROL_DIR}/step-${index}.err`,
  ].join('\n');
  return `exec /bin/bash -c ${shellQuote(body)}`;
}

export const stopJobProcessesScript = [
  'set -eu',
  `if test -f ${CONTROL_DIR}/pgid; then p=$(cat ${CONTROL_DIR}/pgid); case "$p" in *[!0-9]*|'') exit 71;; esac; kill -TERM -- "-$p" 2>/dev/null || :; fi`,
  `pkill -TERM -u ${HOSTED_UID} 2>/dev/null || :`,
  'sleep 1',
  `pkill -KILL -u ${HOSTED_UID} 2>/dev/null || :`,
  `if pgrep -u ${HOSTED_UID} >/dev/null; then exit 72; fi`,
].join('\n');

/** Root-only helper; jobs have already stopped before it copies any snapshot data. */
export const dependencySnapshotScript = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = '/workspace';
const dest = '/tmp/gitknot-snapshot';
const config = JSON.parse(process.env.GITKNOT_CACHE_SPEC);
const tracked = fs.readFileSync('/tmp/gitknot-control/tracked-source','utf8').split('\0').filter(Boolean);
const banned = /^(?:\.git|\.ssh|\.gnupg|\.aws|\.npmrc|\.netrc|\.env(?:\..*)?|credentials?(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
fs.rmSync(dest, {recursive:true,force:true}); fs.mkdirSync(dest,{recursive:true,mode:0o700});
let total=0, files=0;
function copy(relative) {
  const source=path.join(root,relative), target=path.join(dest,relative);
  const stat=fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.nlink>1 && stat.isFile()) throw new Error('Unsafe cache file');
  if (relative.split('/').some(part=>banned.test(part))) return;
  if (stat.isDirectory()) {fs.mkdirSync(target,{recursive:true,mode:0o700}); for(const name of fs.readdirSync(source).sort()) copy(path.join(relative,name)); return;}
  total+=stat.size; if(total>config.max_bytes || ++files>100000) throw new Error('Cache quota exceeded');
  const fd=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const actual=fs.fstatSync(fd); if(actual.ino!==stat.ino || actual.size!==stat.size) throw new Error('Cache changed during inspection');
    const data=fs.readFileSync(fd);
    for (const value of config.masks) if(value && data.includes(Buffer.from(value))) throw new Error('Secret-bearing cache rejected');
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700}); fs.writeFileSync(target,data,{mode:stat.mode&0o111?0o700:0o600,flag:'wx'});
  } finally {fs.closeSync(fd);}
}
for(const relative of config.paths) {
  if(!relative || relative==='.' || path.isAbsolute(relative) || relative.split('/').some(p=>p==='..'||p==='.git')) throw new Error('Unsafe cache path');
  if(tracked.some(file=>file===relative||file.startsWith(relative.replace(/\/$/,'')+'/'))) throw new Error('Dependency cache overlaps tracked source');
  let cursor=root; for(const part of relative.split('/')) {cursor=path.join(cursor,part); if(fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Cache path is a symlink');}
  if(fs.existsSync(path.join(root,relative))) copy(relative);
}
fs.writeFileSync(path.join(dest,'.gitknot-cache.json'),JSON.stringify({version:1,bytes:total,files,paths:config.paths}),{mode:0o600});
process.stdout.write(JSON.stringify({bytes:total,files}));
`;

export const dependencyRestoreScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const spec=JSON.parse(process.env.GITKNOT_CACHE_SPEC),root='/workspace',cache='/tmp/gitknot-snapshot';
let total=0;
function copy(relative) {
 const source=path.join(cache,relative),target=path.join(root,relative),stat=fs.lstatSync(source);
 if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||relative.split('/').includes('.git')) throw new Error('Unsafe dependency cache');
 if(stat.isDirectory()) {fs.mkdirSync(target,{recursive:true});fs.chownSync(target,spec.uid??10000,spec.gid??10000); for(const name of fs.readdirSync(source).sort()) copy(path.join(relative,name));return;}
 total+=stat.size;if(total>spec.max_bytes)throw new Error('Dependency cache quota exceeded');
 if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw new Error('Cache target is a symlink');
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);fs.chownSync(target,spec.uid??10000,spec.gid??10000);
}
for(const relative of spec.paths) {
 if(relative==='.'||path.isAbsolute(relative)||relative.split('/').some(p=>p==='..'||p==='.git'))throw new Error('Unsafe cache path');
 if(cp.execFileSync('git',['-C',root,'ls-files','--',relative],{encoding:'utf8'}).trim())throw new Error('Cache overlaps tracked source');
 let cursor=root;for(const part of relative.split('/')) {cursor=path.join(cursor,part);if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw new Error('Unsafe target');}
 cursor=root;for(const part of relative.split('/').slice(0,-1)){cursor=path.join(cursor,part);fs.mkdirSync(cursor,{recursive:true});fs.chownSync(cursor,spec.uid??10000,spec.gid??10000);}
 if(fs.existsSync(path.join(cache,relative)))copy(relative);
}
`;
