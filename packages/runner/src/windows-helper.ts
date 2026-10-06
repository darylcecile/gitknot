/** Trusted supervisor code: never contains a workflow script or credential literal. */
export const WINDOWS_ISOLATION_CSHARP = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace GitKnot {
  public static class NativeIsolation {
    [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
      public int cb; public string reserved; public string desktop; public string title;
      public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2;
      public IntPtr reservedPtr,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct SIX { public SI startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC { public long processTime,jobTime; public uint flags; public UIntPtr minimum,maximum; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long a,b,c,d; public uint faults,total,active,terminated; }
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref EXT info,int size);
    [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNT info,int size,IntPtr returned);
    [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32", SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32", SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA attrs,int size);
    [DllImport("kernel32", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
    [DllImport("kernel32", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr handle,uint time);
    [DllImport("kernel32", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("user32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowStation(string name,uint flags,uint access,ref SA security);
    [DllImport("user32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,uint flags,uint access,ref SA security);
    [DllImport("user32", SetLastError=true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32", SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32")] static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint size);
    [DllImport("kernel32")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LogonUser(string user,string domain,string password,int type,int provider,out IntPtr token);
    [DllImport("advapi32", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disableCount,IntPtr disable,uint deleteCount,IntPtr delete,uint restrictCount,IntPtr restrict,out IntPtr restricted);
    [DllImport("advapi32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token,string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI process);

    static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static Dictionary<string,object> Parse(string json) { return new JavaScriptSerializer { MaxJsonLength=1048576 }.Deserialize<Dictionary<string,object>>(json); }
    static string Str(Dictionary<string,object> spec,string key) { return Convert.ToString(spec[key]); }
    static IntPtr Login(Dictionary<string,object> spec) {
      if(WindowsIdentity.GetCurrent().User.Value!="S-1-5-18")throw new InvalidOperationException("Native Windows execution requires a LocalSystem service supervisor.");
      if(Process.GetCurrentProcess().SessionId!=0)throw new InvalidOperationException("The native Windows supervisor must run in service session zero.");
      IntPtr token; Check(LogonUser(Str(spec,"username"),Str(spec,"domain"),Str(spec,"password"),4,0,out token));
      try {
        using(var identity=new WindowsIdentity(token)) {
          if(identity.User==null || identity.User.Equals(WindowsIdentity.GetCurrent().User) || identity.User.Value=="S-1-5-18" || identity.Groups.Cast<IdentityReference>().Any(g=>g.Value=="S-1-5-32-544"))
            throw new InvalidOperationException("Distinct nonadministrator batch-logon account required.");
        }
        return token;
      } catch { CloseHandle(token); throw; }
    }
    static string Sid(IntPtr token) { using(var identity=new WindowsIdentity(token)) return identity.User.Value; }
    static List<IntPtr> UserProcesses(string sid) {
      var handles=new List<IntPtr>();
      foreach(var process in Process.GetProcesses()) using(process) {
        IntPtr handle=OpenProcess(0x1001,false,process.Id); if(handle==IntPtr.Zero) continue;
        IntPtr token;
        if(OpenProcessToken(handle,8,out token)) {
          try { if(Sid(token)==sid) { handles.Add(handle); continue; } } finally { CloseHandle(token); }
        }
        CloseHandle(handle);
      }
      return handles;
    }
    static void Sweep(string sid) {
      for(int pass=0;pass<50;pass++) {
        var handles=UserProcesses(sid); if(handles.Count==0)return;
        foreach(var handle in handles) { try { Check(TerminateProcess(handle,137)); } finally { CloseHandle(handle); } }
        Thread.Sleep(50);
      }
      throw new InvalidOperationException("Execution user still has active processes.");
    }
    static IntPtr NewJob(string name,int processes) {
      var job=CreateJobObject(IntPtr.Zero,name); if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
      if(Marshal.GetLastWin32Error()==183) { CloseHandle(job); throw new InvalidOperationException("Job identity already exists."); }
      var info=new EXT(); info.basic.flags=0x2000|0x8; info.basic.active=(uint)processes;
      try { Check(SetInformationJobObject(job,9,ref info,Marshal.SizeOf(typeof(EXT)))); return job; } catch { CloseHandle(job); throw; }
    }
    static void VerifyStopped(IntPtr job) {
      for(int pass=0;pass<100;pass++) {
        ACCOUNT info; Check(QueryInformationJobObject(job,1,out info,Marshal.SizeOf(typeof(ACCOUNT)),IntPtr.Zero));
        if(info.active==0)return; Thread.Sleep(20);
      }
      throw new InvalidOperationException("Windows Job Object has active processes.");
    }
    public static int Keeper(string json) {
      var spec=Parse(json); IntPtr token=Login(spec); string sid=Sid(token); CloseHandle(token);
      var existing=UserProcesses(sid); foreach(var handle in existing)CloseHandle(handle);
      if(existing.Count>0)throw new InvalidOperationException("The dedicated execution account is already in use.");
      IntPtr job=NewJob(Str(spec,"job_name"),256);
      IntPtr descriptor=IntPtr.Zero,station=IntPtr.Zero,desktop=IntPtr.Zero;uint descriptorSize;
      try {
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;"+sid+")",1,out descriptor,out descriptorSize));
        var security=new SA {length=Marshal.SizeOf(typeof(SA)),descriptor=descriptor,inherit=0};
        string stationName=Str(spec,"job_name").Replace("Local\\","");
        station=CreateWindowStation(stationName,0,0x37f,ref security);if(station==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr previous=GetProcessWindowStation();Check(SetProcessWindowStation(station));
        try { desktop=CreateDesktop("default",IntPtr.Zero,IntPtr.Zero,0,0x10000000,ref security);if(desktop==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error()); }
        finally { Check(SetProcessWindowStation(previous)); }
        Console.WriteLine("ready"); Console.Out.Flush();
        var input=Task.Run(()=>Console.In.ReadLine());
        long deadline=Convert.ToInt64(spec["deadline_at"]);
        while(!input.Wait(100) && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()<deadline) {}
        Check(TerminateJobObject(job,137)); VerifyStopped(job); Sweep(sid);
        return 0;
      } finally { CloseHandle(job);if(desktop!=IntPtr.Zero)CloseDesktop(desktop);if(station!=IntPtr.Zero)CloseWindowStation(station);if(descriptor!=IntPtr.Zero)LocalFree(descriptor); }
    }
    static string Quote(string value) {
      if(value.Length>0 && !value.Any(c=>Char.IsWhiteSpace(c)||c=='"'))return value;
      var result=new StringBuilder("\"");int slashes=0;
      foreach(char c in value) { if(c=='\\'){slashes++;continue;} if(c=='"')result.Append('\\',slashes*2+1);else result.Append('\\',slashes);result.Append(c);slashes=0; }
      result.Append('\\',slashes*2);return result.Append('"').ToString();
    }
    public static int Command(string json) {
      var spec=Parse(json); IntPtr original=Login(spec), token=IntPtr.Zero, job=IntPtr.Zero, attr=IntPtr.Zero, list=IntPtr.Zero, environment=IntPtr.Zero;
      IntPtr outRead=IntPtr.Zero,outWrite=IntPtr.Zero,errRead=IntPtr.Zero,errWrite=IntPtr.Zero,inRead=IntPtr.Zero,inWrite=IntPtr.Zero; PI child=new PI();
      try {
        Check(CreateRestrictedToken(original,1,0,IntPtr.Zero,0,IntPtr.Zero,0,IntPtr.Zero,out token));
        job=OpenJobObject(0x1|0x4,false,Str(spec,"job_name")); if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
        var security=new SA { length=Marshal.SizeOf(typeof(SA)),inherit=1 };
        Check(CreatePipe(out outRead,out outWrite,ref security,0)); Check(CreatePipe(out errRead,out errWrite,ref security,0)); Check(CreatePipe(out inRead,out inWrite,ref security,0));
        Check(SetHandleInformation(outRead,1,0));Check(SetHandleInformation(errRead,1,0));Check(SetHandleInformation(inWrite,1,0)); CloseHandle(inWrite);inWrite=IntPtr.Zero;
        IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);attr=Marshal.AllocHGlobal(size);
        Check(InitializeProcThreadAttributeList(attr,1,0,ref size));
        list=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.WriteIntPtr(list,0,inRead);Marshal.WriteIntPtr(list,IntPtr.Size,outWrite);Marshal.WriteIntPtr(list,IntPtr.Size*2,errWrite);
        Check(UpdateProcThreadAttribute(attr,0,new IntPtr(0x20002),list,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
        var env=(Dictionary<string,object>)spec["env"];
        environment=Marshal.StringToHGlobalUni(String.Join("\0",env.OrderBy(k=>k.Key,StringComparer.OrdinalIgnoreCase).Select(k=>k.Key+"="+Convert.ToString(k.Value)))+"\0\0");
        var si=new SIX();si.startup.cb=Marshal.SizeOf(typeof(SIX));si.startup.flags=0x100;si.startup.input=inRead;si.startup.output=outWrite;si.startup.error=errWrite;si.startup.desktop=Str(spec,"job_name").Replace("Local\\","")+"\\default";si.attributes=attr;
        string app=Str(spec,"executable");var arguments=((IEnumerable)spec["args"]).Cast<object>().Select(v=>Convert.ToString(v));
        string[] argv=arguments.ToArray();
        var command=new StringBuilder(Path.GetFileName(app).Equals("cmd.exe",StringComparison.OrdinalIgnoreCase)&&argv.Length==4&&argv[2]=="/c"
          ? Quote(app)+" /d /s /c \""+argv[3]+"\"" : Quote(app)+" "+String.Join(" ",argv.Select(Quote)));
        Check(CreateProcessAsUser(token,app,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x400|0x80000|0x8000000,environment,Str(spec,"cwd"),ref si,out child));
        try { Check(AssignProcessToJobObject(job,child.process)); } catch { TerminateProcess(child.process,137);throw; }
        CloseHandle(outWrite);outWrite=IntPtr.Zero;CloseHandle(errWrite);errWrite=IntPtr.Zero;CloseHandle(inRead);inRead=IntPtr.Zero;
        var output=new FileStream(new SafeFileHandle(outRead,true),FileAccess.Read);outRead=IntPtr.Zero;
        var error=new FileStream(new SafeFileHandle(errRead,true),FileAccess.Read);errRead=IntPtr.Zero;
        using(output)using(error) {
          var outTask=Task.Run(()=>output.CopyTo(Console.OpenStandardOutput()));var errTask=Task.Run(()=>error.CopyTo(Console.OpenStandardError()));
          if(ResumeThread(child.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());
          WaitForSingleObject(child.process,0xffffffff);uint code;Check(GetExitCodeProcess(child.process,out code));
          Task.WaitAll(outTask,errTask);return unchecked((int)code);
        }
      } finally {
        if(child.thread!=IntPtr.Zero)CloseHandle(child.thread);if(child.process!=IntPtr.Zero)CloseHandle(child.process);
        foreach(var h in new[]{original,token,job,outRead,outWrite,errRead,errWrite,inRead,inWrite})if(h!=IntPtr.Zero)CloseHandle(h);
        if(attr!=IntPtr.Zero){DeleteProcThreadAttributeList(attr);Marshal.FreeHGlobal(attr);}if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
      }
    }
    public static string Inspect(string json) { var spec=Parse(json);IntPtr token=Login(spec);try{return Sid(token);}finally{CloseHandle(token);} }
    public static int Recover(string json) {
      var spec=Parse(json);IntPtr token=Login(spec);string sid=Sid(token);CloseHandle(token);
      IntPtr job=OpenJobObject(0x8|0x4,false,Str(spec,"job_name"));
      if(job!=IntPtr.Zero)try{Check(TerminateJobObject(job,137));VerifyStopped(job);}finally{CloseHandle(job);}
      else if(Marshal.GetLastWin32Error()!=2)throw new Win32Exception(Marshal.GetLastWin32Error());
      Sweep(sid);return 0;
    }
  }
}`;

export function windowsHelper(action: 'Keeper' | 'Command' | 'Inspect' | 'Recover'): string {
  return `$ErrorActionPreference='Stop'\n$ProgressPreference='SilentlyContinue'\n[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)\n[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)\ntry {\nAdd-Type -ReferencedAssemblies System.Web.Extensions,System.Core -TypeDefinition @'\n${WINDOWS_ISOLATION_CSHARP}\n'@\n$line=[Console]::In.ReadLine()\n${action === 'Inspect' ? `[Console]::Out.WriteLine([GitKnot.NativeIsolation]::Inspect($line))\nexit 0` : `$code=[GitKnot.NativeIsolation]::${action}($line)\nexit $code`}\n} catch { [Console]::Error.WriteLine('GitKnot Windows account/job-object isolation failed; verify service privileges and batch-logon account configuration.');exit 125 }\n`;
}
