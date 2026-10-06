import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompiledOutput, WorkflowLimits } from '../../workflows/src/index.ts';
import { restoreArchive } from './archive.ts';
import { RunnerError } from './errors.ts';
import type { JobIsolation } from './isolation-types.ts';
import type { ProcessGroup } from './process.ts';

/** Runs with the JOB identity/namespace: even a symlink race cannot read supervisor files. */
const SNAPSHOT_SCRIPT = String.raw`
const fs=require('node:fs/promises'),p=require('node:path'),constants=require('node:fs').constants;
const spec=JSON.parse(process.argv[1]),root=process.cwd();let count=0,bytes=0;const seen=new Set();
async function emit(value){const data=Buffer.from(JSON.stringify(value)+'\n');bytes+=data.length;if(bytes>spec.max_bytes)throw Error('limit');if(!process.stdout.write(data))await new Promise(r=>process.stdout.once('drain',r));}
async function visit(name,depth){
 if(depth>64||++count>spec.max_files*4)throw Error('count');
 const parts=name.replace(/\/$/,'').split('/');if(p.isAbsolute(name)||parts.includes('..')||parts.some(s=>s.toLowerCase()==='.git')||name.includes('\\'))throw Error('path');
 const full=p.resolve(root,name),info=await fs.lstat(full);if(info.isSymbolicLink())throw Error('link');
 if(info.isDirectory()){const children=(await fs.readdir(full)).filter(child=>child.toLowerCase()!=='.git').sort();if(!children.length){const relative=p.relative(root,full).split(p.sep).join('/')||'.';if(!seen.has(relative)){seen.add(relative);if(seen.size>spec.max_files)throw Error('count');await emit({type:'directory',path:relative,mode:493});}}for(const child of children)await visit(name==='.'?child:name.replace(/\/$/,'')+'/'+child,depth+1);return;}
 if(!info.isFile()||info.nlink>1)throw Error('file');name=p.relative(root,full).split(p.sep).join('/');if(seen.has(name))return;seen.add(name);if(seen.size>spec.max_files)throw Error('count');
 const file=await fs.open(full,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{const before=await file.stat();if(!before.isFile()||before.nlink>1)throw Error('file');let offset=0,sequence=0;do{const data=Buffer.alloc(Math.min(49152,Math.max(0,before.size-offset)));const read=await file.read(data,0,data.length,offset);if(read.bytesRead!==data.length)throw Error('changed');offset+=data.length;await emit({path:name,mode:before.mode&73?493:420,sequence:sequence++,final:offset===before.size,data_base64:data.toString('base64')});}while(offset<before.size);const after=await file.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('changed');}finally{await file.close();}
}
(async()=>{await emit({format:'gitknot.files',version:1});for(const entry of spec.paths){try{await visit(entry.path,0)}catch(e){if(!entry.required&&e.code==='ENOENT')continue;throw e;}}})().catch(()=>{process.stderr.write('GitKnot output snapshot failed.');process.exitCode=1;});
`;

export async function snapshotStepOutputs(isolation: JobIsolation, definitions: Record<string, CompiledOutput>, options: { workspace: string; control: string; limits: WorkflowLimits; signal: AbortSignal; timeout_ms: number; onGroup?: (group: ProcessGroup) => Promise<void> }): Promise<string> {
  const archive = join(options.control, `snapshot-${randomUUID()}.ndjson`);
  const destination = `${archive}.files`;
  await mkdir(options.control, { recursive: true, mode: 0o700 });
  const file = await open(archive, 'wx', 0o600);
  const hash = createHash('sha256'); let size = 0;
  try {
    const result = await isolation.run('node', ['-e', SNAPSHOT_SCRIPT, JSON.stringify({ paths: Object.values(definitions).map(output => ({ path: output.path, required: output.required })), max_bytes: options.limits.max_output_bytes, max_files: options.limits.max_output_files })], {
      cwd: options.workspace, env: isolation.environment(), signal: options.signal, timeout_ms: options.timeout_ms, onGroup: options.onGroup,
      max_output_bytes: options.limits.max_output_bytes,
      onLog: async data => { size += data.byteLength; if (size > options.limits.max_output_bytes) throw new RunnerError('output_limit', 'Intermediate output snapshot exceeds its byte limit.'); hash.update(data); await file.writeFile(data); },
    });
    if (result.exit_code !== 0 || result.signal) throw new RunnerError('output_snapshot_failed', 'A step output could not be safely snapshotted by the isolated job identity.');
    await file.sync(); await file.close();
    await restoreArchive(archive, destination, { digest: `sha256:${hash.digest('hex')}`, size_bytes: size }, { max_bytes: options.limits.max_output_bytes, max_files: options.limits.max_output_files, signal: options.signal });
    return destination;
  } catch (error) { await file.close().catch(() => {}); await rm(destination, { recursive: true, force: true }); throw error; }
  finally { await rm(archive, { force: true }); }
}
