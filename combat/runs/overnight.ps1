# Run an overnight plan with the PC kept awake for as long as it runs (no
# power settings are changed: the request ends with this script).
#
#   powershell -ExecutionPolicy Bypass -File runs\overnight.ps1                    # the Kingslayer plan
#   powershell -ExecutionPolicy Bypass -File runs\overnight.ps1 -Plan runs\x.json -Only heartless
#
# Stopping it (Ctrl+C) and starting it again resumes: finished stages are kept.
param(
  [string]$Plan = 'runs\kingslayer-overnight.json',
  [string]$Only = ''
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Add-Type -Namespace Win32 -Name Power -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
'@
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED: no sleep; the screen may still turn off.
[void][Win32.Power]::SetThreadExecutionState([uint32]'0x80000001')
try {
  $log = Join-Path (Split-Path $Plan -Parent) ("overnight-{0:yyyyMMdd-HHmm}.log" -f (Get-Date))
  $nodeArgs = @('--experimental-strip-types', '--no-warnings', '--import', './register.mjs', 'tools/overnight.ts', '--plan', $Plan)
  if ($Only) { $nodeArgs += @('--only', $Only) }
  & node @nodeArgs 2>&1 | Tee-Object -FilePath $log
} finally {
  [void][Win32.Power]::SetThreadExecutionState([uint32]'0x80000000')
}
