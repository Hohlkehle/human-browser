// BrowserMcpService.cs - Stage 8 Windows service wrapper for Browser MCP.
//
// Compiles with the csc.exe that ships with Windows (.NET Framework 4.x);
// no external dependencies. See scripts/windows/BrowserMcp.Windows.psm1
// (Invoke-BmcpCompileWrapper) for the exact command line.
//
// Modes:
//   BrowserMcp.Service.exe                       run as a Windows service (SCM);
//                                                supervises `node dist\src\main.js`
//   BrowserMcp.Service.exe -- <command...>       supervise a custom child command
//                                                (used for the optional tunnel service:
//                                                `-- node dist\src\tunnel-cli.js run`)
//   BrowserMcp.Service.exe   (interactive user)  foreground console run (testing)
//   BrowserMcp.Service.exe secret set NAME FILE  read the secret from FILE, store it in
//                                                Windows Credential Manager under
//                                                `browser-mcp/NAME`, then delete FILE
//   BrowserMcp.Service.exe secret check NAME     exit 0 if the credential exists, else 1
//                                                (prints nothing - existence probe only)
//   BrowserMcp.Service.exe secret delete NAME    remove the credential
//   BrowserMcp.Service.exe ctrl PID              internal: attach to PID's console and
//                                                broadcast CTRL_C (spawned by the wrapper
//                                                itself on service stop; an in-process
//                                                GenerateConsoleCtrlEvent would deadlock)
//
// Security model:
//   - Secrets live ONLY in the Credential Manager vault of the dedicated service
//     account (DPAPI-protected, per-user). They are never written to the registry,
//     to service.env, or to a command line; the wrapper injects them into the
//     child's environment block at spawn time.
//   - service.env (state dir) carries non-secret configuration only; the install
//     scripts refuse to put secret-looking values in it.
//   - The child gets its own console (CREATE_NEW_CONSOLE) so a service stop can
//     deliver CTRL_C via AttachConsole + GenerateConsoleCtrlEvent - the graceful
//     shutdown path proven in Stage 1. Force TerminateProcess is only the fallback.

using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace BrowserMcp
{
    internal static class Native
    {
        public const uint CREATE_NEW_CONSOLE = 0x00000010;
        public const uint CREATE_NO_WINDOW = 0x08000000;
        public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        public const uint INFINITE = 0xFFFFFFFF;
        public const uint WAIT_OBJECT_0 = 0x0;
        public const int STARTF_USESTDHANDLES = 0x00000100;
        public const uint CTRL_C_EVENT = 0;
        public const uint HANDLE_FLAG_INHERIT = 1;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public bool bInheritHandle;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(
            string lpApplicationName,
            string lpCommandLine,
            ref SECURITY_ATTRIBUTES lpProcessAttributes,
            ref SECURITY_ATTRIBUTES lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreatePipe(
            out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES sa, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr hProcess, out int exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AttachConsole(int dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FreeConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);
    }

    /// <summary>
    /// Windows Credential Manager (generic credentials) scoped to the account
    /// this process runs as. Target names are `browser-mcp/&lt;NAME&gt;`.
    /// </summary>
    internal static class SecretStore
    {
        private const int CredTypeGeneric = 1;
        private const int CredPersistLocalMachine = 2;
        public const string TargetPrefix = "browser-mcp/";

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL
        {
            public int Flags;
            public int Type;
            public string TargetName;
            public string Comment;
            public long LastWritten;
            public int CredentialBlobSize;
            public IntPtr CredentialBlob;
            public int Persist;
            public int AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias;
            public string UserName;
        }

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CredWriteW(ref CREDENTIAL cred, int flags);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CredDeleteW(string target, int type, int flags);

        [DllImport("advapi32.dll")]
        private static extern void CredFree(IntPtr buffer);

        /// <summary>Returns the secret value, or null when the credential does not exist.</summary>
        public static string Read(string name)
        {
            IntPtr ptr;
            if (!CredReadW(TargetPrefix + name, CredTypeGeneric, 0, out ptr))
            {
                return null;
            }
            try
            {
                CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
                if (cred.CredentialBlobSize <= 0 || cred.CredentialBlob == IntPtr.Zero)
                {
                    return string.Empty;
                }
                byte[] buffer = new byte[cred.CredentialBlobSize];
                Marshal.Copy(cred.CredentialBlob, buffer, 0, cred.CredentialBlobSize);
                return Encoding.UTF8.GetString(buffer);
            }
            finally
            {
                CredFree(ptr);
            }
        }

        public static void Write(string name, string value)
        {
            byte[] blob = Encoding.UTF8.GetBytes(value);
            CREDENTIAL cred = new CREDENTIAL();
            cred.Type = CredTypeGeneric;
            cred.TargetName = TargetPrefix + name;
            cred.CredentialBlobSize = blob.Length;
            cred.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
            cred.Persist = CredPersistLocalMachine;
            cred.UserName = "token";
            Marshal.Copy(blob, 0, cred.CredentialBlob, blob.Length);
            try
            {
                if (!CredWriteW(ref cred, 0))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                Marshal.FreeHGlobal(cred.CredentialBlob);
            }
        }

        public static bool Delete(string name)
        {
            return CredDeleteW(TargetPrefix + name, CredTypeGeneric, 0);
        }
    }

    /// <summary>Thread-safe append-only log file with a hard size cap (one backup).</summary>
    internal sealed class BoundedLogFile
    {
        private readonly string path;
        private readonly long maxBytes;
        private readonly object gate = new object();

        public BoundedLogFile(string path, long maxBytes)
        {
            this.path = path;
            this.maxBytes = maxBytes;
        }

        public string Path
        {
            get { return path; }
        }

        public void Append(string line)
        {
            try
            {
                lock (gate)
                {
                    string dir = System.IO.Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }
                    FileInfo info = new FileInfo(path);
                    if (info.Exists && info.Length >= maxBytes)
                    {
                        string backup = path + ".old";
                        if (File.Exists(backup))
                        {
                            File.Delete(backup);
                        }
                        File.Move(path, backup);
                    }
                    File.AppendAllText(path, line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch
            {
                // Logging must never take the service down.
            }
        }
    }

    /// <summary>Mirrors wrapper events to the bounded stderr.log and the Windows Event Log.</summary>
    internal sealed class EventLogSink
    {
        public const string SourceName = "BrowserMcpService";
        private readonly BoundedLogFile file;
        private readonly bool sourceAvailable;

        public EventLogSink(BoundedLogFile file)
        {
            this.file = file;
            bool available = false;
            try
            {
                available = EventLog.SourceExists(SourceName);
            }
            catch
            {
                available = false;
            }
            sourceAvailable = available;
        }

        public void Info(string message) { Write(message, EventLogEntryType.Information); }
        public void Warn(string message) { Write(message, EventLogEntryType.Warning); }
        public void Error(string message) { Write(message, EventLogEntryType.Error); }

        private void Write(string message, EventLogEntryType type)
        {
            string line = string.Format(
                "[{0}] [{1}] {2}",
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"),
                type,
                message);
            file.Append(line);
            if (sourceAvailable)
            {
                try
                {
                    EventLog.WriteEntry(SourceName, message, type);
                }
                catch
                {
                    // The file copy above already captured the event.
                }
            }
        }
    }

    /// <summary>
    /// Supervises the Browser MCP node process: loads service.env plus
    /// Credential Manager secrets, spawns the child in its own console,
    /// restarts it on crash, and stops it gracefully with CTRL_C.
    /// </summary>
    internal sealed class Host
    {
        private const string DefaultSecretNames = "CDP_GATEWAY_TOKEN,CLOUDFLARE_TUNNEL_TOKEN";
        private const int CrashWindowMs = 180000;
        private const int CrashLimit = 5;
        private const int MaxBackoffMs = 30000;
        private const long StderrLogMaxBytes = 5 * 1024 * 1024;

        private readonly string[] rawArgs;
        private readonly Dictionary<string, string> envVars =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private readonly List<string> childCommand = new List<string>();
        private readonly object spawnGate = new object();

        private EventLogSink events;
        private BoundedLogFile stderrLog;
        private string stateDir;
        private string appDir;
        private int stopTimeoutMs = 20000;

        private Thread monitorThread;
        private ManualResetEvent stopSignal = new ManualResetEvent(false);
        private volatile bool stopRequested;
        private IntPtr processHandle = IntPtr.Zero;
        private int processId;
        private int exitCode;

        public Host(string[] args)
        {
            rawArgs = args ?? new string[0];
        }

        public int StopTimeoutMs
        {
            get { return stopTimeoutMs; }
        }

        public int ExitCode
        {
            get { return exitCode; }
        }

        public void Start()
        {
            stateDir = Environment.GetEnvironmentVariable("BMCP_STATE_DIR");
            if (string.IsNullOrEmpty(stateDir))
            {
                stateDir = @"C:\ProgramData\browser-mcp";
            }
            string logsDir = System.IO.Path.Combine(stateDir, "logs");
            Directory.CreateDirectory(logsDir);
            stderrLog = new BoundedLogFile(System.IO.Path.Combine(logsDir, "stderr.log"), StderrLogMaxBytes);
            events = new EventLogSink(stderrLog);

            LoadServiceEnv();
            LoadChildCommand();

            events.Info(string.Format(
                "Browser MCP service wrapper starting (mode={0}, appDir={1}, child=\"{2}\")",
                Environment.UserInteractive ? "console" : "service",
                appDir,
                string.Join(" ", childCommand.ToArray())));

            monitorThread = new Thread(MonitorLoop);
            monitorThread.IsBackground = true;
            monitorThread.Start();
        }

        /// <summary>Requests a graceful child shutdown (CTRL_C, then force-kill fallback).</summary>
        public void RequestStop()
        {
            if (stopRequested)
            {
                return;
            }
            stopRequested = true;
            stopSignal.Set();
            events.Info("stop requested; sending CTRL_C to the child console");
            SendCtrlCToChild();
        }

        public void WaitForMonitorExit(int timeoutMs)
        {
            if (monitorThread != null)
            {
                monitorThread.Join(timeoutMs);
            }
        }

        private void LoadServiceEnv()
        {
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                envVars[(string)entry.Key] = (string)entry.Value;
            }

            appDir = System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
            appDir = System.IO.Path.GetDirectoryName(appDir); // service\ -> install dir

            string envFile = System.IO.Path.Combine(stateDir, "service.env");
            if (File.Exists(envFile))
            {
                foreach (string rawLine in File.ReadAllLines(envFile, Encoding.UTF8))
                {
                    string line = rawLine.Trim();
                    if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
                    {
                        continue;
                    }
                    int eq = line.IndexOf('=');
                    if (eq <= 0)
                    {
                        continue;
                    }
                    string key = line.Substring(0, eq).Trim();
                    string value = line.Substring(eq + 1).Trim();
                    envVars[key] = value;
                }
                events.Info("service.env loaded from " + envFile);
            }
            else
            {
                events.Warn("service.env not found at " + envFile + "; using process environment only");
            }

            string configuredAppDir;
            if (envVars.TryGetValue("APP_DIR", out configuredAppDir) && configuredAppDir.Length > 0)
            {
                appDir = configuredAppDir;
            }
            string configuredStopTimeout;
            if (envVars.TryGetValue("SERVICE_STOP_TIMEOUT_MS", out configuredStopTimeout))
            {
                int parsed;
                if (int.TryParse(configuredStopTimeout, out parsed) && parsed >= 1000 && parsed <= 120000)
                {
                    stopTimeoutMs = parsed;
                }
            }

            // Secrets: Credential Manager of the service account -> child env.
            string secretNames;
            if (!envVars.TryGetValue("BMCP_SECRET_NAMES", out secretNames) || secretNames.Length == 0)
            {
                secretNames = DefaultSecretNames;
            }
            StringBuilder loaded = new StringBuilder();
            foreach (string rawName in secretNames.Split(','))
            {
                string name = rawName.Trim();
                if (name.Length == 0)
                {
                    continue;
                }
                string value = null;
                try
                {
                    value = SecretStore.Read(name);
                }
                catch
                {
                    value = null;
                }
                if (value != null)
                {
                    envVars[name] = value;
                    loaded.Append(name).Append("=present ");
                }
                else
                {
                    loaded.Append(name).Append("=absent ");
                }
            }
            events.Info("credential manager secrets: " + loaded.ToString().Trim());
        }

        private void LoadChildCommand()
        {
            // Explicit command after `--` wins (used by the tunnel service).
            bool seenSeparator = false;
            foreach (string arg in rawArgs)
            {
                if (!seenSeparator)
                {
                    if (arg == "--")
                    {
                        seenSeparator = true;
                    }
                    continue;
                }
                childCommand.Add(arg);
            }
            if (childCommand.Count == 0)
            {
                string nodeExe;
                if (!envVars.TryGetValue("NODE_EXE", out nodeExe) || nodeExe.Length == 0)
                {
                    nodeExe = "node";
                }
                childCommand.Add(nodeExe);
                childCommand.Add(System.IO.Path.Combine("dist", System.IO.Path.Combine("src", "main.js")));
            }
        }

        private static string QuoteArgument(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
            {
                return arg;
            }
            return "\"" + arg.Replace("\"", "\\\"") + "\"";
        }

        private byte[] BuildEnvironmentBlock()
        {
            StringBuilder builder = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in envVars)
            {
                builder.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            }
            builder.Append('\0');
            return Encoding.Unicode.GetBytes(builder.ToString());
        }

        private bool SpawnChild()
        {
            Native.SECURITY_ATTRIBUTES pipeSa = new Native.SECURITY_ATTRIBUTES();
            pipeSa.nLength = Marshal.SizeOf(pipeSa);
            pipeSa.bInheritHandle = true;

            IntPtr readHandle = IntPtr.Zero;
            IntPtr writeHandle = IntPtr.Zero;
            IntPtr envHandle = IntPtr.Zero;
            try
            {
                if (!Native.CreatePipe(out readHandle, out writeHandle, ref pipeSa, 0))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe failed");
                }
                // The read end must not be inherited by the child.
                Native.SetHandleInformation(readHandle, Native.HANDLE_FLAG_INHERIT, 0);

                byte[] envBlock = BuildEnvironmentBlock();
                GCHandle envPin = GCHandle.Alloc(envBlock, GCHandleType.Pinned);
                try
                {
                    envHandle = envPin.AddrOfPinnedObject();

                    Native.STARTUPINFO si = new Native.STARTUPINFO();
                    si.cb = Marshal.SizeOf(si);
                    si.dwFlags = Native.STARTF_USESTDHANDLES;
                    si.hStdInput = IntPtr.Zero;
                    si.hStdOutput = writeHandle;
                    si.hStdError = writeHandle;

                    StringBuilder commandLine = new StringBuilder();
                    foreach (string part in childCommand)
                    {
                        if (commandLine.Length > 0)
                        {
                            commandLine.Append(' ');
                        }
                        commandLine.Append(QuoteArgument(part));
                    }

                    Native.PROCESS_INFORMATION pi;
                    Native.SECURITY_ATTRIBUTES procSa = new Native.SECURITY_ATTRIBUTES();
                    procSa.nLength = Marshal.SizeOf(procSa);
                    Native.SECURITY_ATTRIBUTES threadSa = new Native.SECURITY_ATTRIBUTES();
                    threadSa.nLength = Marshal.SizeOf(threadSa);

                    bool ok = Native.CreateProcessW(
                        null,
                        commandLine.ToString(),
                        ref procSa,
                        ref threadSa,
                        true, // inherit the pipe write end
                        Native.CREATE_NEW_CONSOLE | Native.CREATE_UNICODE_ENVIRONMENT,
                        envHandle,
                        appDir,
                        ref si,
                        out pi);
                    if (!ok)
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
                    }

                    Native.CloseHandle(pi.hThread);
                    lock (spawnGate)
                    {
                        processHandle = pi.hProcess;
                        processId = pi.dwProcessId;
                    }
                    events.Info(string.Format("child started (pid {0})", pi.dwProcessId));

                    IntPtr pumpHandle = readHandle;
                    readHandle = IntPtr.Zero; // ownership moves to the pump thread
                    Thread pump = new Thread(() => PumpChildOutput(pumpHandle));
                    pump.IsBackground = true;
                    pump.Start();
                    return true;
                }
                finally
                {
                    envPin.Free();
                }
            }
            catch (Exception ex)
            {
                events.Error("failed to start child: " + ex.Message);
                return false;
            }
            finally
            {
                // Parent-side handles: the write end must be closed here so the
                // pump sees EOF once the child (and its children) exit.
                if (writeHandle != IntPtr.Zero)
                {
                    Native.CloseHandle(writeHandle);
                }
                if (readHandle != IntPtr.Zero)
                {
                    Native.CloseHandle(readHandle);
                }
            }
        }

        private void PumpChildOutput(IntPtr readHandle)
        {
            try
            {
#pragma warning disable 618 // IntPtr FileStream ctor: .NET 4.0 compatible wrapper
                using (FileStream stream = new FileStream(readHandle, FileAccess.Read, true, 4096))
#pragma warning restore 618
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        if (line.Length > 8192)
                        {
                            line = line.Substring(0, 8192) + "...[truncated]";
                        }
                        stderrLog.Append("[child] " + line);
                    }
                }
            }
            catch
            {
                // Output pumping must never take the service down.
            }
        }

        private void MonitorLoop()
        {
            Queue<DateTime> recentExits = new Queue<DateTime>();
            int backoffMs = 1000;

            while (!stopRequested)
            {
                DateTime startedAt = DateTime.UtcNow;
                bool spawned = SpawnChild();

                int childExitCode = -1;
                if (spawned)
                {
                    IntPtr handle;
                    lock (spawnGate)
                    {
                        handle = processHandle;
                    }
                    Native.WaitForSingleObject(handle, Native.INFINITE);
                    Native.GetExitCodeProcess(handle, out childExitCode);
                    Native.CloseHandle(handle);
                    lock (spawnGate)
                    {
                        processHandle = IntPtr.Zero;
                        processId = 0;
                    }
                }

                if (stopRequested)
                {
                    events.Info(string.Format("child exited during shutdown (code {0})", childExitCode));
                    break;
                }

                events.Warn(string.Format("child exited unexpectedly (code {0})", childExitCode));
                recentExits.Enqueue(DateTime.UtcNow);
                while (recentExits.Count > 0 &&
                       (DateTime.UtcNow - recentExits.Peek()).TotalMilliseconds > CrashWindowMs)
                {
                    recentExits.Dequeue();
                }
                if (recentExits.Count >= CrashLimit)
                {
                    events.Error(string.Format(
                        "crash loop: {0} exits within {1} ms; wrapper exits so the SCM failure actions can restart the service",
                        CrashLimit, CrashWindowMs));
                    exitCode = 1;
                    // In service mode this triggers the configured recovery actions.
                    Environment.Exit(1);
                    return;
                }

                if ((DateTime.UtcNow - startedAt).TotalMilliseconds > 60000)
                {
                    backoffMs = 1000;
                }
                events.Info(string.Format("restarting child in {0} ms", backoffMs));
                if (stopSignal.WaitOne(backoffMs))
                {
                    break;
                }
                backoffMs = Math.Min(backoffMs * 2, MaxBackoffMs);
            }
            events.Info("wrapper monitor stopped");
        }

        private void SendCtrlCToChild()
        {
            int pid;
            IntPtr handle;
            lock (spawnGate)
            {
                pid = processId;
                handle = processHandle;
            }
            if (pid <= 0 || handle == IntPtr.Zero)
            {
                return;
            }

            // The CTRL_C must be generated by an EXTERNAL process attached to
            // the child's console. Doing it from this process deadlocks: the
            // broadcast would hit our own CLR console handler while we are
            // blocked inside GenerateConsoleCtrlEvent. Hence the tiny
            // `ctrl <pid>` helper mode of this same executable.
            string exePath = System.Reflection.Assembly.GetExecutingAssembly().Location;
            string helperCommand = QuoteArgument(exePath) + " ctrl " + pid;
            Native.STARTUPINFO helperSi = new Native.STARTUPINFO();
            helperSi.cb = Marshal.SizeOf(helperSi);
            Native.PROCESS_INFORMATION helperPi;
            Native.SECURITY_ATTRIBUTES helperProcSa = new Native.SECURITY_ATTRIBUTES();
            helperProcSa.nLength = Marshal.SizeOf(helperProcSa);
            Native.SECURITY_ATTRIBUTES helperThreadSa = new Native.SECURITY_ATTRIBUTES();
            helperThreadSa.nLength = Marshal.SizeOf(helperThreadSa);

            bool helperStarted = Native.CreateProcessW(
                null,
                helperCommand,
                ref helperProcSa,
                ref helperThreadSa,
                false,
                Native.CREATE_NO_WINDOW,
                IntPtr.Zero,
                null,
                ref helperSi,
                out helperPi);
            if (helperStarted)
            {
                Native.WaitForSingleObject(helperPi.hProcess, 5000);
                int helperExit;
                Native.GetExitCodeProcess(helperPi.hProcess, out helperExit);
                Native.CloseHandle(helperPi.hProcess);
                Native.CloseHandle(helperPi.hThread);
                if (helperExit != 0)
                {
                    events.Warn("CTRL_C helper could not deliver the event; falling back to force-kill after timeout");
                }
            }
            else
            {
                events.Warn("could not start the CTRL_C helper; falling back to force-kill after timeout");
            }

            uint waited = Native.WaitForSingleObject(handle, (uint)stopTimeoutMs);
            if (waited != Native.WAIT_OBJECT_0)
            {
                events.Warn(string.Format(
                    "child did not exit within {0} ms after CTRL_C; terminating", stopTimeoutMs));
                Native.TerminateProcess(handle, 1);
            }
            else
            {
                events.Info("child stopped gracefully");
            }
        }
    }

    internal sealed class BrowserMcpService : ServiceBase
    {
        private Host host;

        public BrowserMcpService()
        {
            ServiceName = "BrowserMcpService";
            CanStop = true;
            CanShutdown = true;
        }

        protected override void OnStart(string[] args)
        {
            host = new Host(Environment.GetCommandLineArgs());
            host.Start();
            RequestAdditionalTime(host.StopTimeoutMs + 10000);
        }

        protected override void OnStop()
        {
            RequestAdditionalTime(host.StopTimeoutMs + 10000);
            if (host != null)
            {
                host.RequestStop();
                host.WaitForMonitorExit(host.StopTimeoutMs + 15000);
            }
        }

        protected override void OnShutdown()
        {
            if (host != null)
            {
                host.RequestStop();
                host.WaitForMonitorExit(host.StopTimeoutMs + 5000);
            }
            base.OnShutdown();
        }
    }

    internal static class SecretCli
    {
        private static readonly Regex ValidName = new Regex("^[A-Z][A-Z0-9_]*$");

        public static int Run(string[] args)
        {
            if (args.Length >= 2 && args[1] == "set" && args.Length == 4)
            {
                string name = args[2];
                string file = args[3];
                if (!ValidName.IsMatch(name))
                {
                    Console.Error.WriteLine("invalid secret name (expected [A-Z][A-Z0-9_]*)");
                    return 2;
                }
                if (!File.Exists(file))
                {
                    Console.Error.WriteLine("secret file not found");
                    return 1;
                }
                string value = File.ReadAllText(file, Encoding.UTF8).Trim('\r', '\n', ' ', '\t');
                if (value.Length == 0)
                {
                    Console.Error.WriteLine("secret file is empty");
                    return 1;
                }
                try
                {
                    SecretStore.Write(name, value);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("CredWrite failed: " + ex.Message);
                    return 1;
                }
                try
                {
                    File.Delete(file);
                }
                catch
                {
                    Console.Error.WriteLine("warning: could not delete the temporary secret file");
                }
                Console.WriteLine("secret stored: " + SecretStore.TargetPrefix + name);
                return 0;
            }
            if (args.Length >= 2 && args[1] == "check" && args.Length == 3)
            {
                string value = null;
                try
                {
                    value = SecretStore.Read(args[2]);
                }
                catch
                {
                    value = null;
                }
                return value != null ? 0 : 1;
            }
            if (args.Length >= 2 && args[1] == "delete" && args.Length == 3)
            {
                return SecretStore.Delete(args[2]) ? 0 : 1;
            }
            Console.Error.WriteLine("usage: BrowserMcp.Service.exe secret set NAME FILE | check NAME | delete NAME");
            return 2;
        }
    }

    internal static class Program
    {
        private static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "secret")
            {
                return SecretCli.Run(args);
            }

            if (args.Length == 2 && args[0] == "ctrl")
            {
                // CTRL_C delivery helper: attaches to the target process's
                // console and broadcasts the event. Must run as a separate
                // process (see Host.SendCtrlCToChild for the deadlock reason).
                int targetPid;
                if (!int.TryParse(args[1], out targetPid))
                {
                    return 2;
                }
                Native.FreeConsole();
                if (!Native.AttachConsole(targetPid))
                {
                    return 1;
                }
                Native.SetConsoleCtrlHandler(IntPtr.Zero, true);
                bool sent = Native.GenerateConsoleCtrlEvent(Native.CTRL_C_EVENT, 0);
                Native.FreeConsole();
                return sent ? 0 : 1;
            }

            if (Environment.UserInteractive)
            {
                // Foreground mode for operators and tests: same supervision as
                // the service; Ctrl+C performs the graceful CTRL_C hand-over.
                Host host = new Host(args);
                host.Start();
                ManualResetEvent done = new ManualResetEvent(false);
                Console.CancelKeyPress += (sender, e) =>
                {
                    e.Cancel = true;
                    host.RequestStop();
                    done.Set();
                };
                host.WaitForMonitorExit(Timeout.Infinite);
                done.WaitOne(5000);
                return host.ExitCode;
            }

            ServiceBase.Run(new BrowserMcpService());
            return 0;
        }
    }
}
