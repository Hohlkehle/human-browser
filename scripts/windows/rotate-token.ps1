# rotate-token.ps1 -- Stage 8: rotate the CDP gateway bearer token.
#
# Rotation procedure (zero secret persistence):
#   1. Stop the service (the token lives only in its process environment).
#   2. Temporarily lift the deny-logon rights so the helper can run AS the
#      service account (interactive logon is denied after install).
#   3. Reset the account password (the old one was never stored) and update
#      the service's stored credentials.
#   4. Store the NEW token in the account's Credential Manager via the
#      wrapper's `secret set` (value travels through an ACL'd temp file that
#      is deleted immediately).
#   5. Re-apply the deny-logon rights, start the service, verify:
#      - new token is accepted (anything but 401 on /json/version),
#      - old token is rejected with 401 (when -OldToken is supplied).
#
# Clients must switch to the new token; during the ~2 s restart window the
# gateway is briefly unreachable.

param(
    [string] $ServiceName = 'BrowserMcp',
    [string] $ServiceUser = 'bmcp-svc',
    [string] $StateDir = 'C:\ProgramData\browser-mcp',
    [string] $NewToken,
    [string] $OldToken
)

Import-Module (Join-Path $PSScriptRoot 'BrowserMcp.Windows.psm1') -Force
$ErrorActionPreference = 'Stop'
Assert-BmcpAdmin -ScriptPath $PSCommandPath -PassthroughArgs (ConvertTo-BmcpArgList -BoundParameters $PSBoundParameters)

$installDir = Get-BmcpInstallDir
$wrapper = Invoke-BmcpCompileWrapper -InstallDir $installDir

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) { throw "service $ServiceName not found; run install.ps1 first" }

if ([string]::IsNullOrEmpty($NewToken)) {
    $NewToken = New-BmcpRandomToken
    Write-Host 'generated a new random bearer token'
    Write-Host "  token (shown once, copy it now): $NewToken"
}

# --- 1. Stop the service so no process keeps the old token -------------------
if ($service.Status -eq 'Running') {
    Write-Host "stopping $ServiceName..."
    Stop-Service -Name $ServiceName -Force
}

# --- 2./3. Lift deny rights, reset account password, update service creds ----
Remove-BmcpDenyLogonRights -Account $ServiceUser
try {
    $credential = Initialize-BmcpServiceUser -UserName $ServiceUser
    $plainPassword = $credential.GetNetworkCredential().Password
    Add-BmcpServiceLogonRight -Account $ServiceUser
    & sc.exe config $ServiceName obj= ".\$ServiceUser" password= $plainPassword | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe config $ServiceName failed" }

    # --- 4. Store the new token in the account's Credential Manager ----------
    Set-BmcpSecret -WrapperExe $wrapper -Name 'CDP_GATEWAY_TOKEN' -Value $NewToken `
        -Credential $credential -StateDir $StateDir
}
finally {
    # --- 5a. Re-apply the deny-logon rights even if something failed ---------
    Add-BmcpDenyLogonRights -Account $ServiceUser
}

# --- 5b. Restart and verify ---------------------------------------------------
Start-Service -Name $ServiceName
if (-not (Wait-BmcpHealth -Url 'http://127.0.0.1:9229/healthz' -TimeoutSeconds 30)) {
    throw 'gateway did not become healthy after rotation; check the Application event log'
}

$newStatus = Get-BmcpHttpStatus -Url 'http://127.0.0.1:9229/json/version' -Headers @{ Authorization = "Bearer $NewToken" }
if ($newStatus -eq 401 -or $null -eq $newStatus) {
    throw "rotation FAILED: the new token was not accepted (status $newStatus)"
}
Write-Host "new token accepted: /json/version -> $newStatus (502 = Chrome not running, auth OK)"

if (-not [string]::IsNullOrEmpty($OldToken)) {
    $oldStatus = Get-BmcpHttpStatus -Url 'http://127.0.0.1:9229/json/version' -Headers @{ Authorization = "Bearer $OldToken" }
    if ($oldStatus -ne 401) {
        throw "rotation FAILED: the old token is still accepted (status $oldStatus)"
    }
    Write-Host 'old token rejected: /json/version -> 401'
}

Write-Host ''
Write-Host 'Bearer token rotated successfully. Update all clients (adapter env, Playwright headers) to the new token.'
