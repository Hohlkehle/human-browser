# BrowserMcp.Windows.psm1 -- Stage 8 shared helpers for Windows deployment.
#
# Used by install.ps1, uninstall.ps1, upgrade.ps1, rollback.ps1,
# rotate-token.ps1, emergency-stop.ps1 and security-checklist.ps1.
# Everything here is idempotent where practical; secrets never appear in
# output, in service.env, or on a command line.
#
# NOTE: keep this file pure ASCII -- Windows PowerShell 5.1 reads BOM-less
# files with the ANSI code page and multi-byte UTF-8 breaks parsing.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Elevation
# ---------------------------------------------------------------------------

function Test-BmcpAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-BmcpAdmin {
    param(
        [Parameter(Mandatory = $true)] [string] $ScriptPath,
        [string[]] $PassthroughArgs = @()
    )
    if (Test-BmcpAdmin) { return }
    Write-Warning 'This script requires administrator; re-launching elevated (UAC).'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ScriptPath`"") + $PassthroughArgs
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
    exit 0
}

function ConvertTo-BmcpArgList {
    <# Rebuilds a CLI argument list from $PSBoundParameters for self-elevation. #>
    param([hashtable] $BoundParameters)
    $result = @()
    foreach ($key in $BoundParameters.Keys) {
        $value = $BoundParameters[$key]
        if ($value -is [System.Management.Automation.SwitchParameter]) {
            if ($value.IsPresent) { $result += "-$key" }
        }
        elseif ($value -is [array]) {
            foreach ($item in $value) { $result += @("-$key", "$item") }
        }
        else {
            $result += @("-$key", "$value")
        }
    }
    return $result
}

# ---------------------------------------------------------------------------
# Paths and wrapper compilation
# ---------------------------------------------------------------------------

function Get-BmcpInstallDir {
    <# The repository root: two levels above this module (scripts\windows\). #>
    return (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
}

function Get-BmcpWrapperPath {
    param([string] $InstallDir = (Get-BmcpInstallDir))
    return (Join-Path $InstallDir 'service\BrowserMcp.Service.exe')
}

function Invoke-BmcpCompileWrapper {
    <#
        Compiles scripts\windows\BrowserMcpService.cs with the csc.exe that
        ships with Windows (.NET Framework 4.x). No downloads, no dependencies.
        Recompiles only when the source is newer than the executable.
    #>
    param([string] $InstallDir = (Get-BmcpInstallDir))

    $csc = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $csc)) {
        throw "csc.exe not found at $csc (.NET Framework 4.x is required)"
    }
    $source = Join-Path $PSScriptRoot 'BrowserMcpService.cs'
    $serviceDir = Join-Path $InstallDir 'service'
    if (-not (Test-Path -LiteralPath $serviceDir)) {
        New-Item -ItemType Directory -Path $serviceDir | Out-Null
    }
    $exe = Join-Path $serviceDir 'BrowserMcp.Service.exe'

    $needsBuild = $true
    if (Test-Path -LiteralPath $exe) {
        $srcTime = (Get-Item -LiteralPath $source).LastWriteTime
        $exeTime = (Get-Item -LiteralPath $exe).LastWriteTime
        $needsBuild = $srcTime -gt $exeTime
    }
    if (-not $needsBuild) { return $exe }

    $ref = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319\System.ServiceProcess.dll'
    & $csc /nologo /target:exe /out:$exe /reference:$ref $source
    if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }
    Write-Host "wrapper compiled: $exe"
    return $exe
}

# ---------------------------------------------------------------------------
# Random secrets
# ---------------------------------------------------------------------------

function New-BmcpRandomToken {
    <# 32 random bytes as 64 hex chars -- long enough for bearer tokens. #>
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function New-BmcpRandomPassword {
    <#
        Random local-account password. It is never stored anywhere: after
        install it is known to nobody, and rotate-token.ps1 resets it on
        every rotation.
    #>
    $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $chars = foreach ($b in $bytes) { $alphabet[[int]($b % $alphabet.Length)] }
    return (-join $chars) + 'x1!' # satisfy complexity policy
}

# ---------------------------------------------------------------------------
# LSA logon rights (deny interactive/network logon for the service account)
# ---------------------------------------------------------------------------

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;

public static class BmcpLsa
{
    private const uint POLICY_ALL_ACCESS = 0x000F0FFF;

    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_UNICODE_STRING
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_OBJECT_ATTRIBUTES
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaOpenPolicy(
        ref LSA_UNICODE_STRING SystemName,
        ref LSA_OBJECT_ATTRIBUTES ObjectAttributes,
        uint DesiredAccess,
        out IntPtr PolicyHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaAddAccountRights(
        IntPtr PolicyHandle, byte[] AccountSid, LSA_UNICODE_STRING[] UserRights, uint CountOfRights);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaRemoveAccountRights(
        IntPtr PolicyHandle, byte[] AccountSid, byte AllRights, LSA_UNICODE_STRING[] UserRights, uint CountOfRights);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaClose(IntPtr PolicyHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaNtStatusToWinError(uint Status);

    private static IntPtr OpenPolicy()
    {
        LSA_UNICODE_STRING systemName = new LSA_UNICODE_STRING();
        LSA_OBJECT_ATTRIBUTES attrs = new LSA_OBJECT_ATTRIBUTES();
        IntPtr handle;
        uint status = LsaOpenPolicy(ref systemName, ref attrs, POLICY_ALL_ACCESS, out handle);
        if (status != 0)
        {
            throw new System.ComponentModel.Win32Exception((int)LsaNtStatusToWinError(status));
        }
        return handle;
    }

    private static byte[] GetSidBytes(string account)
    {
        NTAccount acct = new NTAccount(account);
        SecurityIdentifier sid = (SecurityIdentifier)acct.Translate(typeof(SecurityIdentifier));
        byte[] bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        return bytes;
    }

    private static LSA_UNICODE_STRING[] MakeRights(string right)
    {
        LSA_UNICODE_STRING[] rights = new LSA_UNICODE_STRING[1];
        rights[0].Buffer = Marshal.StringToHGlobalUni(right);
        rights[0].Length = (ushort)(right.Length * 2);
        rights[0].MaximumLength = (ushort)((right.Length + 1) * 2);
        return rights;
    }

    private static void Mutate(string account, string right, bool add)
    {
        IntPtr policy = OpenPolicy();
        try
        {
            byte[] sid = GetSidBytes(account);
            LSA_UNICODE_STRING[] rights = MakeRights(right);
            uint status = add
                ? LsaAddAccountRights(policy, sid, rights, 1)
                : LsaRemoveAccountRights(policy, sid, 0, rights, 1);
            Marshal.FreeHGlobal(rights[0].Buffer);
            if (status != 0 && status != 0x00000521) // 0x521 = right not present (remove is idempotent)
            {
                throw new System.ComponentModel.Win32Exception((int)LsaNtStatusToWinError(status));
            }
        }
        finally
        {
            LsaClose(policy);
        }
    }

    public static void AddRight(string account, string right) { Mutate(account, right, true); }
    public static void RemoveRight(string account, string right) { Mutate(account, right, false); }
}
'@

function Add-BmcpDenyLogonRights {
    <#
        Hardens the service account: it may only log on as a service.
        Interactive and network logon are denied. (Service logon is a
        separate right and stays granted.)
    #>
    param([Parameter(Mandatory = $true)] [string] $Account)
    [BmcpLsa]::AddRight($Account, 'SeDenyInteractiveLogonRight')
    [BmcpLsa]::AddRight($Account, 'SeDenyNetworkLogonRight')
}

function Remove-BmcpDenyLogonRights {
    param([Parameter(Mandatory = $true)] [string] $Account)
    [BmcpLsa]::RemoveRight($Account, 'SeDenyInteractiveLogonRight')
    [BmcpLsa]::RemoveRight($Account, 'SeDenyNetworkLogonRight')
}

function Add-BmcpServiceLogonRight {
    <#
        Grants SeServiceLogonRight explicitly. CreateService is supposed to
        grant it implicitly, but that is not reliable across Windows builds --
        an explicit grant is idempotent and removes the doubt.
    #>
    param([Parameter(Mandatory = $true)] [string] $Account)
    [BmcpLsa]::AddRight($Account, 'SeServiceLogonRight')
}

# ---------------------------------------------------------------------------
# ACLs
# ---------------------------------------------------------------------------

function Set-BmcpAcl {
    <#
        Replaces the ACL (inheritance removed): SYSTEM + Administrators full
        control, optional accounts get Read (or Modify with -ModifyAccounts).
        Well-known principals are referenced by SID so the script works on
        any Windows display language.
    #>
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [string[]] $ReadAccounts = @(),
        [string[]] $ModifyAccounts = @()
    )
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity
        $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    }
    else {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        # Files cannot carry inheritance flags.
        $inherit = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)

    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    $prop = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow

    # S-1-5-18 = SYSTEM, S-1-5-32-544 = Administrators (locale-independent).
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $full, $inherit, $prop, $allow)
        $acl.AddAccessRule($rule)
    }
    $readRights = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor `
        [System.Security.AccessControl.FileSystemRights]::Read
    foreach ($account in $ReadAccounts) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($account, $readRights, $inherit, $prop, $allow)
        $acl.AddAccessRule($rule)
    }
    foreach ($account in $ModifyAccounts) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($account, [System.Security.AccessControl.FileSystemRights]::Modify, $inherit, $prop, $allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# ---------------------------------------------------------------------------
# Service account
# ---------------------------------------------------------------------------

function Initialize-BmcpServiceUser {
    <#
        Creates (or resets) the dedicated least-privilege local account.
        Returns a PSCredential with a fresh random password. The password is
        never persisted; rotate-token.ps1 resets it on every rotation.
    #>
    param([Parameter(Mandatory = $true)] [string] $UserName)

    $password = New-BmcpRandomPassword
    $secure = ConvertTo-SecureString -String $password -AsPlainText -Force

    $existing = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        New-LocalUser -Name $UserName -Password $secure `
            -PasswordNeverExpires -UserMayNotChangePassword `
            -Description 'Browser MCP service account (Stage 8)' | Out-Null
        Write-Host "created local user: $UserName"
    }
    else {
        # Set-LocalUser takes -PasswordNeverExpires as [bool], not a switch;
        # "user may not change password" is only settable at creation time --
        # the password is random and stored nowhere, so this is acceptable.
        Set-LocalUser -Name $UserName -Password $secure -PasswordNeverExpires:$true
        Write-Host "reset password for existing user: $UserName"
    }

    # The account must never be privileged (SID = locale-independent).
    $admins = Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue
    if ($admins | Where-Object { $_.Name -like "*\$UserName" }) {
        throw "$UserName is a member of Administrators; refusing to use a privileged account"
    }
    return (New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$UserName", $secure))
}

# ---------------------------------------------------------------------------
# Credential Manager secrets (via the wrapper, running AS the service user)
# ---------------------------------------------------------------------------

function Set-BmcpSecret {
    <#
        Stores a secret in the service account's Credential Manager vault.
        The value travels through a tightly ACL'd temp file that the wrapper
        deletes after CredWrite; it never appears on a command line.
    #>
    param(
        [Parameter(Mandatory = $true)] [string] $WrapperExe,
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [string] $Value,
        [Parameter(Mandatory = $true)] [System.Management.Automation.PSCredential] $Credential,
        [string] $StateDir = 'C:\ProgramData\browser-mcp'
    )
    $tmpDir = Join-Path $StateDir 'tmp'
    if (-not (Test-Path -LiteralPath $tmpDir)) {
        New-Item -ItemType Directory -Path $tmpDir | Out-Null
    }
    $tmp = Join-Path $tmpDir ("{0}-{1}.secret" -f $Name, ([guid]::NewGuid().ToString('N')))
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($tmp, $Value, $utf8NoBom)
    try {
        # Modify (not just Read): the wrapper must be able to DELETE the file
        # after CredWrite so the secret never lingers on disk.
        Set-BmcpAcl -Path $tmp -ModifyAccounts @($Credential.UserName)
        $proc = Start-Process -FilePath $WrapperExe `
            -ArgumentList @('secret', 'set', $Name, $tmp) `
            -Credential $Credential -Wait -PassThru -WindowStyle Hidden
        if ($proc.ExitCode -ne 0) {
            throw "secret set for $Name failed (wrapper exit $($proc.ExitCode))"
        }
        if (Test-Path -LiteralPath $tmp) {
            throw "temporary secret file was not deleted by the wrapper: $tmp"
        }
        Write-Host "secret stored in Credential Manager: browser-mcp/$Name"
    }
    finally {
        if (Test-Path -LiteralPath $tmp) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        }
    }
}

function Remove-BmcpSecret {
    param(
        [Parameter(Mandatory = $true)] [string] $WrapperExe,
        [Parameter(Mandatory = $true)] [string] $Name,
        [Parameter(Mandatory = $true)] [System.Management.Automation.PSCredential] $Credential
    )
    $proc = Start-Process -FilePath $WrapperExe `
        -ArgumentList @('secret', 'delete', $Name) `
        -Credential $Credential -Wait -PassThru -WindowStyle Hidden
    if ($proc.ExitCode -eq 0) {
        Write-Host "secret deleted from Credential Manager: browser-mcp/$Name"
        return $true
    }
    Write-Warning "secret delete for $Name returned $($proc.ExitCode) (may not exist)"
    return $false
}

# ---------------------------------------------------------------------------
# service.env
# ---------------------------------------------------------------------------

function Test-BmcpEnvLineSecretFree {
    <#
        service.env must never contain secret values. Keys that merely NAME a
        secret variable (..._ENV) or list secret names (BMCP_SECRET_NAMES) are
        allowed; anything else that looks like a token/password/secret is not.
    #>
    param([Parameter(Mandatory = $true)] [string] $Line)
    $trimmed = $Line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { return $true }
    if ($trimmed -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') { return $true }
    $key = $Matches[1]
    $value = $Matches[2]
    if ($key -match '_ENV$' -or $key -eq 'BMCP_SECRET_NAMES') { return $true }
    if ($key -match '(?i)(TOKEN|SECRET|PASSWORD|KEY)$' -and $value -ne '') { return $false }
    return $true
}

function Write-BmcpServiceEnv {
    <#
        Writes the non-secret service configuration. Defaults mirror
        .env.example; -Overrides supplies KEY=VALUE replacements.
    #>
    param(
        [Parameter(Mandatory = $true)] [string] $StateDir,
        [Parameter(Mandatory = $true)] [string] $InstallDir,
        [Parameter(Mandatory = $true)] [string] $NodeExe,
        [string[]] $Overrides = @()
    )
    $defaults = [ordered]@{
        APP_DIR                   = $InstallDir
        NODE_EXE                  = $NodeExe
        CDP_ENDPOINT              = 'http://127.0.0.1:9222'
        CDP_ALLOWED_CIDRS         = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'
        GATEWAY_ENABLED           = 'true'
        GATEWAY_LISTEN_HOST       = '127.0.0.1'
        GATEWAY_LISTEN_PORT       = '9229'
        GATEWAY_TARGET            = 'http://127.0.0.1:9222'
        GATEWAY_ALLOWED_CIDRS     = '127.0.0.1/32'
        GATEWAY_BEARER_TOKEN_ENV  = 'CDP_GATEWAY_TOKEN'
        GATEWAY_RATE_LIMIT_WINDOW_MS = '60000'
        GATEWAY_RATE_LIMIT_MAX    = '120'
        BROWSER_ALLOWED_DOMAINS   = 'partslink24.com,www.partslink24.com,partsouq.com,www.partsouq.com'
        BROWSER_VISIBLE_MODE_REQUIRED = 'true'
        MCP_TRANSPORT             = 'streamable-http'
        MCP_LISTEN_HOST           = '127.0.0.1'
        MCP_LISTEN_PORT           = '9230'
        MCP_OPERATION_TIMEOUT_MS  = '30000'
        HUMAN_TIMEOUT_MS          = '300000'
        LOG_FILE                  = (Join-Path $StateDir 'logs\browser-mcp.log')
        LOG_FILE_MAX_BYTES        = '10485760'
        LOG_FILE_MAX_FILES        = '5'
        LOG_FILE_MAX_AGE_DAYS     = '14'
        BMCP_SECRET_NAMES         = 'CDP_GATEWAY_TOKEN,CLOUDFLARE_TUNNEL_TOKEN'
        SERVICE_STOP_TIMEOUT_MS   = '20000'
    }
    foreach ($override in $Overrides) {
        if ($override -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            throw "invalid -Env entry (expected KEY=VALUE): $override"
        }
        $defaults[$Matches[1]] = $Matches[2]
    }

    $lines = @('# Browser MCP service configuration -- NON-SECRET values only (Stage 8).')
    $lines += '# Secrets live in the service account''s Windows Credential Manager (browser-mcp/<NAME>).'
    foreach ($key in $defaults.Keys) {
        $line = "$key=$($defaults[$key])"
        if (-not (Test-BmcpEnvLineSecretFree -Line $line)) {
            throw "refusing to write a secret-looking value into service.env: $key"
        }
        $lines += $line
    }
    $envFile = Join-Path $StateDir 'service.env'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($envFile, $lines, $utf8NoBom)
    return $envFile
}

# ---------------------------------------------------------------------------
# Firewall (NetSecurity module -- locale-independent, unlike netsh output)
# ---------------------------------------------------------------------------

function Get-BmcpPortRules {
    <# All firewall rules whose port filter matches -Port. #>
    param([Parameter(Mandatory = $true)] [int] $Port)
    $result = @()
    $portFilters = Get-NetFirewallPortFilter -Protocol TCP -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq "$Port" }
    foreach ($filter in $portFilters) {
        $rule = $filter | Get-NetFirewallRule
        $address = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule
        $result += [pscustomobject]@{
            Name          = $rule.Name
            DisplayName   = $rule.DisplayName
            Enabled       = $rule.Enabled
            Action        = $rule.Action
            Direction     = $rule.Direction
            RemoteAddress = $address.RemoteAddress
        }
    }
    return $result
}

function Set-BmcpGatewayFirewallRule {
    <#
        Exactly one scoped allow rule for the gateway port: inbound TCP from
        the trusted subnet only. Any pre-existing rules for the port (incl.
        remoteip=any) are removed first.
    #>
    param(
        [Parameter(Mandatory = $true)] [string] $Subnet,
        [int] $Port = 9229
    )
    Remove-BmcpPortRules -Port $Port
    New-NetFirewallRule -DisplayName 'Browser MCP CDP gateway (subnet only)' `
        -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $Port -RemoteAddress $Subnet `
        -Description 'Stage 8: CDP gateway reachable from the trusted subnet only' | Out-Null
    Write-Host "firewall: inbound TCP $Port allowed from $Subnet only"
}

function Remove-BmcpPortRules {
    param([Parameter(Mandatory = $true)] [int] $Port)
    $existing = Get-BmcpPortRules -Port $Port
    foreach ($rule in $existing) {
        Remove-NetFirewallRule -Name $rule.Name
        Write-Host "firewall: removed rule '$($rule.DisplayName)' (port $Port)"
    }
}

function Remove-BmcpAllFirewallRules {
    <# Removes everything Stage 8 may have created (port rules + emergency blocks). #>
    Remove-BmcpPortRules -Port 9229
    Remove-BmcpPortRules -Port 9230
    Get-NetFirewallRule -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Browser MCP EMERGENCY BLOCK*' } |
        Remove-NetFirewallRule
}

# ---------------------------------------------------------------------------
# IP helpers
# ---------------------------------------------------------------------------

function ConvertTo-BmcpUInt32 {
    param([Parameter(Mandatory = $true)] [System.Net.IPAddress] $Address)
    $b = $Address.GetAddressBytes()
    return (([uint32]$b[0] -shl 24) -bor ([uint32]$b[1] -shl 16) -bor ([uint32]$b[2] -shl 8) -bor [uint32]$b[3])
}

function Test-BmcpIpInCidr {
    param(
        [Parameter(Mandatory = $true)] [string] $Ip,
        [Parameter(Mandatory = $true)] [string] $Cidr
    )
    $parts = $Cidr.Split('/')
    if ($parts.Count -ne 2) { return $false }
    $bits = [int]$parts[1]
    if ($bits -lt 0 -or $bits -gt 32) { return $false }
    # Compute the mask in 64 bits, then fold back to UInt32. NB: the hex
    # literal 0xFFFFFFFF parses as Int32 -1 in PowerShell and cannot be cast
    # to UInt64 -- use [uint32]::MaxValue instead.
    $allBits = [uint64][uint32]::MaxValue
    $mask = if ($bits -eq 0) {
        [uint32]0
    }
    else {
        [uint32](($allBits -shl (32 - $bits)) -band $allBits)
    }
    try {
        $a = ConvertTo-BmcpUInt32 ([System.Net.IPAddress]::Parse($Ip))
        $b = ConvertTo-BmcpUInt32 ([System.Net.IPAddress]::Parse($parts[0]))
    }
    catch {
        return $false
    }
    return ($a -band $mask) -eq ($b -band $mask)
}

function Get-BmcpLocalIPv4 {
    <# All local IPv4 addresses with their prefix lengths (loopback excluded). #>
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object IPAddress, PrefixLength, PrefixOrigin
}

function Test-BmcpExternalTcp {
    <#
        TRUE external TCP probe from the WSL2 VM (genuine remote traffic that
        Windows Firewall filters -- unlike a local self-probe, which bypasses
        inbound rules). Returns $true/$false, or $null when WSL is unusable.
        Tries every registered distro (container distros like docker-desktop
        have no bash and are skipped).
    #>
    param(
        [Parameter(Mandatory = $true)] [string] $TargetHost,
        [Parameter(Mandatory = $true)] [int] $Port,
        [int] $TimeoutSeconds = 4
    )
    $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if ($null -eq $wsl) { return $null }
    $raw = (wsl.exe -l -q 2>&1 | Out-String)
    # wsl prints UTF-16; PS decodes it via the ANSI console codepage, leaving a
    # NUL between every character. Strip NULs first, THEN split on newlines,
    # and finally drop '*' default markers / stray punctuation.
    $raw = $raw -replace "`0", ''
    $distros = @($raw -split "[\r\n]+" |
        ForEach-Object { ($_.Trim() -replace '[^A-Za-z0-9._-]', '') } |
        Where-Object { $_ -ne '' })
    $script = "timeout $TimeoutSeconds bash -c 'true <> /dev/tcp/$TargetHost/$Port' && echo OPEN || echo CLOSED"
    foreach ($distro in $distros) {
        try {
            # 2>&1 merges stderr so EAP=Stop cannot turn wsl noise into an exception.
            $result = (& wsl.exe -d $distro -e bash -c $script 2>&1 | Out-String)
        }
        catch {
            continue
        }
        if ($result -match 'OPEN') { return $true }
        if ($result -match 'CLOSED') { return $false }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------

function Test-BmcpTcp {
    <# Fast TCP connect probe (Test-NetConnection is too slow for many checks). #>
    param(
        [Parameter(Mandatory = $true)] [string] $TargetHost,
        [Parameter(Mandatory = $true)] [int] $Port,
        [int] $TimeoutMs = 2000
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            $client.EndConnect($async)
            return $true
        }
        return $false
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Wait-BmcpHealth {
    <# Polls a health URL until it answers 200 or the deadline passes. #>
    param(
        [Parameter(Mandatory = $true)] [string] $Url,
        [int] $TimeoutSeconds = 30
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return $true }
        }
        catch {
            # not up yet
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-BmcpHttpStatus {
    <# Returns the status code, or $null on connection failure. #>
    param(
        [Parameter(Mandatory = $true)] [string] $Url,
        [hashtable] $Headers
    )
    $params = @{ Uri = $Url; UseBasicParsing = $true; TimeoutSec = 5 }
    if ($Headers) { $params.Headers = $Headers }
    try {
        $response = Invoke-WebRequest @params
        return [int]$response.StatusCode
    }
    catch [System.Net.WebException] {
        if ($null -ne $_.Exception.Response) {
            return [int]$_.Exception.Response.StatusCode
        }
        return $null
    }
    catch {
        return $null
    }
}

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

function New-BmcpService {
    <#
        Creates a service running as the dedicated account with autostart and
        restart-on-failure recovery actions. Uses sc.exe because Windows
        PowerShell 5.1's New-Service cannot set the service account.
    #>
    param(
        [Parameter(Mandatory = $true)] [string] $ServiceName,
        [Parameter(Mandatory = $true)] [string] $DisplayName,
        [Parameter(Mandatory = $true)] [string] $Description,
        [Parameter(Mandatory = $true)] [string] $BinPath,
        [Parameter(Mandatory = $true)] [string] $UserName,
        [Parameter(Mandatory = $true)] [string] $Password
    )
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        & sc.exe delete $ServiceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sc.exe delete $ServiceName failed" }
        Start-Sleep -Seconds 1
    }
    & sc.exe create $ServiceName binPath= $BinPath obj= ".\$UserName" password= $Password start= auto displayname= $DisplayName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe create $ServiceName failed" }
    & sc.exe description $ServiceName $Description | Out-Null
    # Restart 2s/5s/15s on failure; reset the failure counter daily.
    & sc.exe failure $ServiceName reset= 86400 actions= restart/2000/restart/5000/restart/15000 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe failure $ServiceName failed" }
    Write-Host "service created: $ServiceName (autostart, restart-on-failure, account .\$UserName)"
}

function Remove-BmcpService {
    param([Parameter(Mandatory = $true)] [string] $ServiceName)
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $existing) { return $false }
    if ($existing.Status -eq 'Running') {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    & sc.exe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe delete $ServiceName failed" }
    Write-Host "service deleted: $ServiceName"
    return $true
}

function Initialize-BmcpEventLogSource {
    try {
        New-EventLog -LogName Application -Source 'BrowserMcpService' -ErrorAction Stop
        Write-Host 'event log source registered: BrowserMcpService'
    }
    catch {
        # Source already exists (or cannot be created -- the wrapper degrades
        # gracefully to its bounded file log).
    }
}
