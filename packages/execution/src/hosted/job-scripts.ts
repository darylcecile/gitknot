import { CONTROL_DIR } from './scripts.ts';
import type { CompletionReceipt } from '../types.ts';
import { ApiError } from '@gitknot/core';

/** Root-only setup before any repository command. Fail closed on kernel errors. */
export const hardenJobHostScript = String.raw`
set -eu
export PATH=/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
test "$(id -u)" = 0
test "$(id -u gitknot)" = 10000
test "$(id -g gitknot)" = 10000
test -x /usr/bin/setpriv
test -x /usr/bin/setsid
test -x /usr/bin/pkill
test -x /usr/sbin/iptables
test -x /usr/sbin/ip6tables
test -x /usr/local/bin/node
mkdir -p /tmp/gitknot-control /home/gitknot
chmod 711 /tmp/gitknot-control
chmod 700 /home/gitknot
for firewall in /usr/sbin/iptables /usr/sbin/ip6tables; do
  "$firewall" -w -N GITKNOT_JOB 2>/dev/null || "$firewall" -w -F GITKNOT_JOB
  "$firewall" -w -A GITKNOT_JOB -m addrtype --dst-type LOCAL -j REJECT
  "$firewall" -w -A GITKNOT_JOB -p tcp -m multiport --dports 80,443 -j RETURN
  # DNS is restricted to the platform's configured resolver addresses. The
  # provider's interception/DNS behavior is a separate remote acceptance gate.
  for resolver in $(awk '$1 == "nameserver" {print $2}' /etc/resolv.conf); do
    case "$firewall:$resolver" in
      /usr/sbin/iptables:*:*) continue;;
      /usr/sbin/ip6tables:*.*) continue;;
    esac
    "$firewall" -w -A GITKNOT_JOB -p udp -d "$resolver" --dport 53 -j RETURN
  done
  "$firewall" -w -A GITKNOT_JOB -j REJECT
  "$firewall" -w -C OUTPUT -m owner --uid-owner 10000 -j GITKNOT_JOB 2>/dev/null || "$firewall" -w -I OUTPUT 1 -m owner --uid-owner 10000 -j GITKNOT_JOB
  "$firewall" -w -C OUTPUT -m owner --uid-owner 10000 -j GITKNOT_JOB
done
test "$(stat -c %u /tmp/gitknot-control)" = 0
`;

/** No tenant-controlled env is present until setpriv has dropped all privilege. */
export function launchStepScript(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 128) throw new TypeError('Invalid step index.');
  return `exec /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root /bin/bash --noprofile --norc -c 'ulimit -H -S -n 1024; ulimit -H -S -u 256; umask 077; exec /usr/local/bin/node ${CONTROL_DIR}/supervisor.cjs ${index}'`;
}

/**
 * The SDK supervises this root-owned launcher. Its child runs as uid/gid 10000.
 * Root retains the lease watchdog, process-group journal, bounded log sinks and
 * kernel exit evidence. These are not files that repository code can overwrite.
 */
export const jobSupervisorScript = String.raw`
'use strict';
const fs=require('node:fs'),cp=require('node:child_process');
const root='/tmp/gitknot-control',index=Number(process.argv[2]);
if(!Number.isInteger(index)||index<0||index>=128||process.getuid()!==0)process.exit(70);
fs.mkdirSync(root+'/once-'+index,{mode:0o700}); // O_EXCL execution claim, also fences SDK transport retries.
const config=JSON.parse(fs.readFileSync(root+'/step-'+index+'.json','utf8'));
const cwd=fs.realpathSync('/workspace/'+config.working_directory);
if(cwd!=='/workspace'&&!cwd.startsWith('/workspace/'))process.exit(70);
if(!['sh','bash'].includes(config.shell))process.exit(70);
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/home/gitknot',TMPDIR:'/tmp',CI:'true',SSL_CERT_FILE:'/etc/ssl/certs/ca-certificates.crt',REQUESTS_CA_BUNDLE:'/etc/ssl/certs/ca-certificates.crt',NODE_EXTRA_CA_CERTS:'/etc/cloudflare/certs/cloudflare-containers-ca.crt',...config.env};
for(const [name,value]of Object.entries(env))if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||typeof value!=='string'||value.includes('\0'))process.exit(70);
const args=['--reuid=10000','--regid=10000','--clear-groups','--no-new-privs','--bounding-set=-all','/usr/bin/env','-i',...Object.entries(env).map(([k,v])=>k+'='+v),'/bin/'+config.shell,root+'/step-'+index+'.sh'];
const stdout=fs.createWriteStream(root+'/step-'+index+'.out',{flags:'wx',mode:0o600});
const stderr=fs.createWriteStream(root+'/step-'+index+'.err',{flags:'wx',mode:0o600});
let total=0,reason=null,resource=null,child,killTimer,closed=false,ioFailure=false;
const start=Date.now(),end=Math.min(config.deadline,config.step_deadline);
function kill(signal){if(child&&child.pid){try{process.kill(-child.pid,signal);}catch{} }try{cp.execFileSync('/usr/bin/pkill',['-'+signal.replace('SIG',''),'-u','10000'],{stdio:'ignore'});}catch{}}
function stop(why,exhaustion){if(reason)return;reason=why;resource=exhaustion||null;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1000);}
function memoryKills(){try{return Number(/(?:^|\n)oom_kill (\d+)/.exec(fs.readFileSync('/sys/fs/cgroup/memory.events','utf8'))?.[1]||0);}catch{return 0;}}
const initialKills=memoryKills();
function pipe(input,output){input.on('data',data=>{const remaining=Math.max(0,config.log_bytes-total);const part=data.subarray(0,remaining);total+=part.length;if(part.length&&!output.write(part)){input.pause();output.once('drain',()=>input.resume());}if(part.length!==data.length)stop('quota','logs');});input.on('error',()=>{ioFailure=true;stop('infrastructure');});output.on('error',error=>{ioFailure=true;stop(error.code==='ENOSPC'?'quota':'infrastructure',error.code==='ENOSPC'?'disk':null);});}
child=cp.spawn('/usr/bin/setpriv',args,{cwd,detached:true,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/root'},stdio:['ignore','pipe','pipe']});
if(child.pid)fs.writeFileSync(root+'/pgid',String(child.pid),{mode:0o600});
pipe(child.stdout,stdout);pipe(child.stderr,stderr);
const watchdog=setInterval(()=>{try{const lease=JSON.parse(fs.readFileSync(root+'/lease.json','utf8'));if(Date.now()>=Math.min(end,Date.parse(lease.deadline_at)))stop('deadline');else if(Date.now()>=Date.parse(lease.lease_expires_at))stop('lease');const disk=fs.statfsSync('/workspace');if(disk.bavail*disk.bsize<33554432)stop('quota','disk');if(memoryKills()>initialKills)stop('quota','memory');}catch{stop('infrastructure');}},200);
process.on('SIGTERM',()=>stop('cancelled'));
process.on('SIGINT',()=>stop('cancelled'));
child.on('error',error=>{ioFailure=true;stop(error.code==='EAGAIN'||error.code==='ENOMEM'?'quota':'infrastructure',error.code==='EAGAIN'?'processes':error.code==='ENOMEM'?'memory':null);});
child.on('close',(code,signal)=>{
  if(closed)return;closed=true;clearInterval(watchdog);if(killTimer)clearTimeout(killTimer);kill('SIGKILL');
  let live=false;try{cp.execFileSync('/usr/bin/pgrep',['-u','10000'],{stdio:'ignore'});live=true;}catch(error){if(error.status!==1)live=true;}
  let pending=2;const finish=()=>{if(--pending)return;const outcome={exit_code:Number.isInteger(code)?code:null,signal:signal||null,reason:reason||(ioFailure?'infrastructure':null),resource_exhaustion:resource,process_group_stopped:!live,started_at:new Date(start).toISOString(),finished_at:new Date().toISOString(),log_bytes:total};fs.writeFileSync(root+'/step-'+index+'.result.next',JSON.stringify(outcome),{mode:0o600,flag:'wx'});fs.renameSync(root+'/step-'+index+'.result.next',root+'/step-'+index+'.result.json');process.exitCode=ioFailure||live?70:0;};stdout.end(finish);stderr.end(finish);
});
`;

export const verifyExactSourceScript = (commit: string) => `test "$(git -C /workspace rev-parse HEAD)" = '${commit}' && git -C /workspace -c core.hooksPath=/dev/null -c core.fsmonitor=false diff --exit-code HEAD --`;

export interface HostedProcessResult {
  exit_code: number | null;
  signal: string | null;
  reason: 'deadline' | 'lease' | 'cancelled' | 'quota' | 'infrastructure' | null;
  resource_exhaustion: CompletionReceipt['resource_exhaustion'];
  process_group_stopped: boolean;
  started_at: string;
  finished_at: string;
  log_bytes: number;
}

export function parseHostedProcessResult(text: string): HostedProcessResult {
  let result: HostedProcessResult;
  try { result = JSON.parse(text) as HostedProcessResult; } catch { throw new ApiError(503, 'process_exit_unconfirmed', 'The root supervisor did not record an exit.'); }
  if (!(result.exit_code === null || Number.isInteger(result.exit_code) && result.exit_code >= 0 && result.exit_code <= 255)
    || !(result.signal === null || /^SIG[A-Z0-9]+$/.test(result.signal)) || ![null, 'deadline', 'lease', 'cancelled', 'quota', 'infrastructure'].includes(result.reason)
    || ![null, 'memory', 'disk', 'processes', 'logs', 'outputs', 'egress'].includes(result.resource_exhaustion)
    || typeof result.process_group_stopped !== 'boolean' || !Number.isFinite(Date.parse(result.started_at)) || !Number.isFinite(Date.parse(result.finished_at))
    || !Number.isSafeInteger(result.log_bytes) || result.log_bytes < 0) throw new ApiError(503, 'process_exit_unconfirmed', 'The root supervisor returned invalid exit facts.');
  return { ...result, signal: result.exit_code === null && !result.signal ? 'UNKNOWN' : result.signal };
}

export function hostedProcessConclusion(result: HostedProcessResult): CompletionReceipt['conclusion'] {
  if (result.reason === 'deadline') return 'timed_out';
  if (result.reason === 'cancelled') return 'cancelled';
  if (result.reason === 'infrastructure' || result.reason === 'lease' || !result.process_group_stopped) return 'infrastructure_failed';
  return result.exit_code === 0 && !result.signal && !result.resource_exhaustion && !result.reason ? 'succeeded' : 'failed';
}
