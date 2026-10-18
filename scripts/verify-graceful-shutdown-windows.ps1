$ErrorActionPreference = 'Stop'

$code = @'
using System;
using System.Runtime.InteropServices;

public static class Win {
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX, dwY, dwXSize, dwYSize;
        public int dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    public const uint CREATE_NEW_CONSOLE = 0x00000010;
    public const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    public const uint CTRL_C_EVENT = 0;
    public const uint INFINITE = 0xFFFFFFFF;
    public const uint WAIT_TIMEOUT = 0x00000102;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(
        string lpApplicationName, string lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleCtrlHandler(IntPtr HandlerRoutine, bool Add);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out int lpExitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
}
'@
Add-Type -TypeDefinition $code

# 1) Start node server in its OWN console + process group so CTRL_C can be delivered.
$nodeExe = (Get-Command node).Source
$si = New-Object Win+STARTUPINFO
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
$pi = New-Object Win+PROCESS_INFORMATION
$cmd = '"' + $nodeExe + '" "E:\souce\human-browser\dist\src\main.js"'
$ok = [Win]::CreateProcess($nodeExe, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false,
    ([Win]::CREATE_NEW_CONSOLE -bor [Win]::CREATE_NEW_PROCESS_GROUP),
    [IntPtr]::Zero, 'E:\souce\human-browser', [ref]$si, [ref]$pi)
if (-not $ok) { throw "CreateProcess failed: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
$pid2 = $pi.dwProcessId
$hProc = $pi.hProcess
Write-Output "Started server PID=$pid2 in new console+group"

Start-Sleep -Seconds 2

# 2) Confirm it is up.
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9230/healthz' -UseBasicParsing -TimeoutSec 5
    Write-Output "healthz: $($r.StatusCode) $($r.Content)"
} catch {
    Write-Output "healthz FAILED: $_"
}

# 3) Attach to the child's console, ignore our own Ctrl+C, then broadcast CTRL_C.
[Win]::FreeConsole() | Out-Null
$att = [Win]::AttachConsole([uint32]$pid2)
Write-Output "AttachConsole: $att"
[Win]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
$sent = [Win]::GenerateConsoleCtrlEvent([Win]::CTRL_C_EVENT, 0)
Write-Output "GenerateConsoleCtrlEvent(CTRL_C, group 0): $sent"

# 4) Wait up to 8s for exit.
$wait = [Win]::WaitForSingleObject($hProc, 8000)
if ($wait -eq [Win]::WAIT_TIMEOUT) {
    Write-Output 'TIMEOUT waiting for exit -> force killing'
    [Win]::TerminateProcess($hProc, 1) | Out-Null
    [Win]::CloseHandle($hProc) | Out-Null
    Write-Output 'GRACEFUL SHUTDOWN FAILED'
    exit 1
}

$exitCode = 0
[Win]::GetExitCodeProcess($hProc, [ref]$exitCode) | Out-Null
[Win]::CloseHandle($hProc) | Out-Null
$hex = '0x{0:X8}' -f $exitCode
Write-Output "Process exited. ExitCode = $exitCode ($hex)"

if ($exitCode -eq 0) {
    Write-Output 'GRACEFUL SHUTDOWN OK (exit code 0 -> SIGINT handler ran and event loop drained)'
} elseif ($exitCode -eq -1073741510) {
    Write-Output 'DEFAULT CTRL_C TERMINATION (0xC000013A) -> SIGINT handler did NOT run'
    exit 1
} else {
    Write-Output "UNEXPECTED EXIT CODE: $exitCode"
    exit 1
}
