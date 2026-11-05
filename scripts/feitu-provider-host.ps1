[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [Parameter()]
    [string[]]$CommandArgs = @(),

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# Keep native nonzero exits as exit codes, including when the caller uses PowerShell 7.3+.
$PSNativeCommandUseErrorActionPreference = $false
$environmentName = 'OPENBOT_PROVIDER_LIFECYCLE'
$oldValue = [Environment]::GetEnvironmentVariable($environmentName, 'Process')
$oldExists = $null -ne $oldValue
$exitCode = 0
$environmentChanged = $false

try {
    $command = Get-Command -Name $FilePath -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) {
        throw 'Executable validation failed.'
    }

    $FilePath = $command.Path
    if ($DryRun) {
        Write-Output 'Dry run: executable is available. No process was started and no environment variable was changed.'
    }
    else {
    Set-Item -Path ("Env:" + $environmentName) -Value 'always-on'
    $environmentChanged = $true
    $LASTEXITCODE = 0
    & $FilePath @CommandArgs
    $exitCode = $LASTEXITCODE
    }
}
catch {
    [Console]::Error.WriteLine('Feitu provider host: validation or invocation failed.')
    $exitCode = 1
}
finally {
    if ($environmentChanged -and $oldExists) {
        Set-Item -Path ("Env:" + $environmentName) -Value $oldValue
    }
    elseif ($environmentChanged) {
        Remove-Item -Path ("Env:" + $environmentName) -ErrorAction SilentlyContinue
    }
}

if ($null -ne $exitCode) {
    exit $exitCode
}

# Invoke as a script; do not dot-source. Windows/ARM64 execution has not been verified.
# Usage example with a generic executable only:
# .\scripts\feitu-provider-host.ps1 -FilePath "provider-host.exe" -CommandArgs @("--mode", "run")
# The wrapper does not establish a real application invocation; existing CLI OAuth login is separate.
