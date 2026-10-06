import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeJob, runProcess, cleanEnvironment, inspectToolchain } from '/opt/gitknot/dist/runner/src/index.js';
import { compileWorkflow } from '/opt/gitknot/dist/workflows/src/index.js';

const root = await mkdtemp('/tmp/gitknot-native-');
await chmod(root, 0o711);
await mkdir(join(root, 'source'));
await mkdir(join(root, 'state'), { mode: 0o700 });
await mkdir(join(root, 'canary')); await chmod(join(root, 'canary'), 0o777);
const credential = join(root, 'state', 'machine.json');
await writeFile(credential, 'root-supervisor-machine-credential', { mode: 0o600 });
const git = async (args) => {
  let output = '';
  const result = await runProcess('git', args, { cwd: join(root, 'source'), env: cleanEnvironment(root), timeout_ms: 10000, onLog: async bytes => { output += Buffer.from(bytes).toString('utf8'); } });
  if (result.exit_code !== 0) throw Error('Git fixture creation failed');
  return output.trim();
};
try {
  await git(['init', '-q']); await git(['config', 'user.name', 'Fixture']); await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(root, 'source', 'README'), 'native boundary');
  await git(['add', '.']); await git(['commit', '-qm', 'fixture']);
  const commit = await git(['rev-parse', 'HEAD']);
  const descriptor = await inspectToolchain(['node', 'git'], { cwd: root, home: root });
  const marker = join(root, 'canary', 'late');
  const childScript = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),3000);setInterval(()=>{},1000)`;
  const attack = `const fs=require('node:fs');try{fs.readFileSync(${JSON.stringify(credential)});throw Error('credential leaked')}catch(e){if(e.code!=='EACCES')throw e}if(process.getuid()!==62001||process.getgroups().includes(0))throw Error('identity boundary');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'}).unref();process.stdout.write('BOUNDARY_ENFORCED');setInterval(()=>{},1000)`;
  const definition = { version:1,name:'native',triggers:['workflow.dispatch'],source:'event.commit',defaults:{executor:{type:'self_hosted',pool:'native'},toolchain:'native@1.0.0',timeout:'15s'},access:{repository:'read'},jobs:{test:{steps:[{run:`node -e '${attack.replaceAll("'", "'\\''")}'`}]}} };
  const plan = await compileWorkflow(definition,{repo_id:'r_native',commit,workflow_revision:commit,event:{type:'workflow.dispatch'},trust:{level:'trusted',fork:false,producer_id:'fixture'},policy:{revision:'1',allowed_workflow_revisions:[commit],access:{repository:'read'},hosted_profiles:[],self_hosted_pools:{native:{trust:'trusted',disposable:false}},inapplicable_jobs:[]},toolchains:{'native@1.0.0':descriptor}});
  const abort = new AbortController(); let logs = '';
  const result = await executeJob(plan,'test',{source:{url:join(root,'source'),commit},work_root:join(root,'work'),output_directory:join(root,'outputs'),allow_local_source:true,isolation:{type:'posix_user',uid:62001,gid:62001},signal:abort.signal,grace_ms:50,onLog:async bytes=>{logs+=Buffer.from(bytes).toString('utf8');if(logs.includes('BOUNDARY_ENFORCED'))abort.abort();}});
  if(result.outcome!=='cancelled'||!logs.includes('BOUNDARY_ENFORCED'))throw Error(JSON.stringify(result));
  await new Promise(resolve=>setTimeout(resolve,3200));
  try { await readFile(marker); throw Error('orphan survived'); } catch(error) { if(error.code!=='ENOENT')throw error; }
  if(await readFile(credential,'utf8')!=='root-supervisor-machine-credential')throw Error('supervisor credential changed');
  process.stdout.write('NATIVE_ISOLATION_AND_ORPHAN_CLEANUP_PASSED\n');
} finally { await rm(root,{recursive:true,force:true}); }
