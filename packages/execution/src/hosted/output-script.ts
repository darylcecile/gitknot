/** Executed as root after all uid-10000 processes have been stopped. */
export const collectOutputScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const spec=JSON.parse(process.env.GITKNOT_OUTPUT_SPEC),root='/workspace';
function canonical(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';}
function safe(relative){if(!relative||path.isAbsolute(relative)||/[\x00-\x1f\\:]/.test(relative)||relative.split('/').some(p=>p==='..'||p.toLowerCase()==='.git'))throw new Error('Unsafe output path');let full=root;for(const part of relative.split('/')){full=path.join(full,part);if(fs.lstatSync(full).isSymbolicLink())throw new Error('Output symlink');}return full;}
function scan(data,tail){const joined=Buffer.concat([tail,data]);for(const value of spec.masks)if(value&&joined.includes(Buffer.from(value)))throw new Error('Secret-bearing output rejected');return joined.subarray(Math.max(0,joined.length-spec.mask_width));}
const source=safe(spec.path),stat=fs.lstatSync(source),target=spec.destination;
if(spec.type!=='artifact'){
 if(!stat.isFile()||stat.nlink!==1||stat.size>Math.min(spec.max_bytes,spec.kind==='report'?16777216:65536))throw new Error('Invalid typed output');
 let data=fs.readFileSync(source);scan(data,Buffer.alloc(0));let failed=false;
 if(spec.kind==='report'){
  if(spec.format==='junit'){const text=data.toString('utf8');if(/<!DOCTYPE|<!ENTITY/i.test(text)||!/<testsuites?\b/.test(text)||!/<\/testsuites?>/.test(text))throw new Error('Invalid test report');failed=/<(?:failure|error)\b/.test(text)||/\b(?:failures|errors)=["'][1-9]/.test(text);}
  else {const value=JSON.parse(data);if(spec.format==='sarif'){if(value.version!=='2.1.0'||!Array.isArray(value.runs))throw new Error('Invalid SARIF');failed=value.runs.some(run=>(run.results||[]).some(r=>r.level==='error'));}}
 }else{let value=spec.type==='string'?data.toString('utf8').replace(/\r?\n$/,''):JSON.parse(data);if(spec.type!=='json'&&typeof value!==spec.type)throw new Error('Output type mismatch');data=Buffer.from(canonical(value));scan(data,Buffer.alloc(0));}
 if(data.length>spec.max_bytes)throw new Error('Output quota exceeded');fs.writeFileSync(target,data,{mode:0o600,flag:'wx'});process.stdout.write(JSON.stringify({size_bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),failed}));process.exit(0);
}
const files=[];
function walk(relative,depth){if(depth>64)throw new Error('Output depth exceeded');const full=safe(relative),st=fs.lstatSync(full);if(st.isDirectory()){for(const name of fs.readdirSync(full).sort())if(name.toLowerCase()!=='.git')walk(path.join(relative,name),depth+1);return;}if(!st.isFile()||st.nlink!==1)throw new Error('Unsafe output');files.push(relative);if(files.length>100000)throw new Error('Too many output files');}
walk(spec.path,0);files.sort();const strip=stat.isDirectory()?spec.path:path.dirname(spec.path),seen=new Set(),fd=fs.openSync(target,'wx',0o600),hash=crypto.createHash('sha256');let total=0;
function write(value){const data=Buffer.from(canonical(value)+'\n');total+=data.length;if(total>spec.max_bytes)throw new Error('Output quota exceeded');hash.update(data);fs.writeSync(fd,data);}
try{write({format:'gitknot.files',version:1});for(const relative of files){const name=path.relative(path.join(root,strip),path.join(root,relative));if(!name||name==='.'||seen.has(name.toLowerCase()))throw new Error('Ambiguous output');seen.add(name.toLowerCase());const input=fs.openSync(safe(relative),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const before=fs.fstatSync(input);let offset=0,sequence=0,tail=Buffer.alloc(0);do{const data=Buffer.alloc(Math.min(49152,before.size-offset));if(fs.readSync(input,data,0,data.length,offset)!==data.length)throw new Error('Output changed');tail=scan(data,tail);offset+=data.length;write({path:name,mode:before.mode&0o111?493:420,sequence:sequence++,final:offset===before.size,data_base64:data.toString('base64')});}while(offset<before.size);const after=fs.fstatSync(input);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error('Output changed');}finally{fs.closeSync(input);}}fs.fsyncSync(fd);}finally{fs.closeSync(fd);}process.stdout.write(JSON.stringify({size_bytes:total,sha256:hash.digest('hex'),failed:false}));
`;

export const restoreInputScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),crypto=require('node:crypto');
const spec=JSON.parse(process.env.GITKNOT_INPUT_SPEC),target=spec.destination;
if(fs.existsSync(target))throw new Error('Input destination exists');fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o755});fs.mkdirSync(target,{mode:0o700});
(async()=>{const lines=readline.createInterface({input:fs.createReadStream(spec.archive,{highWaterMark:65536}),crlfDelay:Infinity});let header=false,active=null,total=0,count=0;const names=new Set();for await(const line of lines){if(line.length>70000)throw new Error('Archive record too large');const row=JSON.parse(line);if(!header){if(row.format!=='gitknot.files'||row.version!==1)throw new Error('Invalid archive');header=true;continue;}
if(!row.path||path.isAbsolute(row.path)||/[\x00-\x1f\\:]/.test(row.path)||row.path.split('/').some(p=>!p||p==='..'||p==='.'||p.toLowerCase()==='.git')||![420,493].includes(row.mode)||typeof row.final!=='boolean')throw new Error('Unsafe archive record');
if(!active){if(row.sequence!==0||names.has(row.path.toLowerCase())||++count>100000)throw new Error('Archive file sequence');fs.mkdirSync(path.dirname(path.join(target,row.path)),{recursive:true,mode:0o755});active={path:row.path,mode:row.mode,sequence:0,fd:fs.openSync(path.join(target,row.path),'wx',0o600)};}
if(active.path!==row.path||active.sequence++!==row.sequence||active.mode!==row.mode)throw new Error('Archive sequence');const bytes=Buffer.from(row.data_base64,'base64');if(bytes.toString('base64')!==row.data_base64||(!row.final&&bytes.length!==49152))throw new Error('Archive encoding');total+=bytes.length;if(total>spec.max_bytes)throw new Error('Input quota');fs.writeSync(active.fd,bytes);if(row.final){fs.fchmodSync(active.fd,row.mode&73?365:292);fs.closeSync(active.fd);names.add(row.path.toLowerCase());active=null;}}
if(!header||active)throw new Error('Incomplete archive');fs.chmodSync(target,0o555);})().catch(()=>{process.exitCode=1;});
`;
