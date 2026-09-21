<#
  Tests the non-UI logic inside build-gui.ps1 without opening a window.

  The functions are lifted out of the real script with the PowerShell parser, so
  this exercises the shipped code rather than a copy. Runs on Windows PowerShell
  5.1 and on PowerShell 7 (Linux/macOS), which is how it runs in CI.

      pwsh scripts/test-build-gui.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$guiPath = Join-Path $PSScriptRoot 'build-gui.ps1'

$passed = 0
$failed = 0
function Check([bool]$ok, [string]$label) {
  if ($ok) { Write-Host "  [pass] $label"; $script:passed++ }
  else { Write-Host "  [FAIL] $label" -ForegroundColor Red; $script:failed++ }
}

# ---- 1. the file parses -----------------------------------------------------

$errors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($guiPath, [ref]$tokens, [ref]$errors)
Check ($errors.Count -eq 0) "build-gui.ps1 parses with no syntax errors"
if ($errors.Count) {
  $errors | ForEach-Object { Write-Host ("    line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) }
  exit 1
}

# ---- 2. lift the pure functions out and define them here --------------------

$wanted = @(
  'Read-NewText', 'Bump', 'Get-AppVersion', 'Set-AppVersion', 'Test-Dependencies',
  'Start-Shell', 'Read-TextNoBom', 'Write-TextNoBom', 'Repair-PackageJson'
)
$functions = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($fn in $functions) {
  if ($wanted -contains $fn.Name) { . ([scriptblock]::Create($fn.Extent.Text)) }
}
Check ((Get-Command Read-NewText -ErrorAction SilentlyContinue) -ne $null) "Read-NewText is defined"
Check ((Get-Command Bump -ErrorAction SilentlyContinue) -ne $null) "Bump is defined"

# ---- 3. version bumping -----------------------------------------------------

Check ((Bump '1.0.0' 'patch') -eq '1.0.1') "patch bump"
Check ((Bump '1.0.9' 'patch') -eq '1.0.10') "patch bump past 9"
Check ((Bump '1.2.7' 'minor') -eq '1.3.0') "minor bump resets patch"
Check ((Bump '1.2.7' 'major') -eq '2.0.0') "major bump resets minor and patch"
Check ((Bump 'garbage' 'patch') -eq '1.0.1') "nonsense version falls back"

# ---- 4. version is read from and written to package.json --------------------

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("ffgui-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  Copy-Item (Join-Path $root 'package.json') (Join-Path $temp 'package.json')
  $original = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version

  $root = $temp   # Get-AppVersion / Set-AppVersion read $root
  Check ((Get-AppVersion) -eq $original) "reads the version out of package.json"

  Set-AppVersion '9.8.7'
  Check ((Get-AppVersion) -eq '9.8.7') "writes the version back"

  $json = Get-Content (Join-Path $temp 'package.json') -Raw | ConvertFrom-Json
  Check ($json.name -eq 'finfolio') "rewriting the version leaves the rest of package.json valid"
  Check ($json.scripts.dist -ne $null) "scripts survive the rewrite"

  # The bug that broke a real build: Windows PowerShell's Set-Content -Encoding
  # UTF8 prepends a byte-order mark. Node's require() hides it, so only
  # electron-builder fails — with "Unexpected token '﻿'". Check the bytes,
  # not the parsed text, or PowerShell 7 (which writes no BOM) hides it again.
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $temp 'package.json'))
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  Check (-not $hasBom) "the rewritten package.json has no byte-order mark"
  Check ($bytes[0] -eq [byte][char]'{') "the file still starts with an open brace"

  # …and a file that already has one is repaired rather than passed along.
  $withBom = [byte[]](0xEF, 0xBB, 0xBF) + [System.Text.Encoding]::UTF8.GetBytes('{"name":"finfolio","version":"2.0.0"}')
  [System.IO.File]::WriteAllBytes((Join-Path $temp 'package.json'), $withBom)
  Check ((Get-AppVersion) -eq '2.0.0') "a file with a byte-order mark can still be read"

  $repaired = Repair-PackageJson
  Check ($repaired -contains 'package.json') "Repair-PackageJson reports what it fixed"
  $after = [System.IO.File]::ReadAllBytes((Join-Path $temp 'package.json'))
  Check ($after[0] -eq [byte][char]'{') "the byte-order mark is stripped in place"
  Check ((Get-AppVersion) -eq '2.0.0') "repairing does not change the contents"

  $again = Repair-PackageJson
  Check ($again.Count -eq 0) "repairing a clean file does nothing"
} finally {
  $root = Split-Path -Parent $PSScriptRoot
}

# ---- 5. the tailing reader (this is what was broken before) -----------------

$outFile = Join-Path $temp 'tail.log'
Set-Content -Path $outFile -Value "first line" -NoNewline
$pos = 0
$text = Read-NewText $outFile ([ref]$pos)
Check ($text -eq 'first line') "reads the first chunk"
Check ($pos -gt 0) "advances the read position"

$before = $pos
$text = Read-NewText $outFile ([ref]$pos)
Check ($text -eq '') "returns nothing when the file has not grown"
Check ($pos -eq $before) "position is unchanged when there is nothing new"

Add-Content -Path $outFile -Value "`nsecond line"
$text = Read-NewText $outFile ([ref]$pos)
Check ($text -match 'second line') "reads only the newly appended text"
Check ($text -notmatch 'first line') "does not repeat text it already read"

$missing = Join-Path $temp 'does-not-exist.log'
$mpos = 0
Check ((Read-NewText $missing ([ref]$mpos)) -eq '') "a missing file reads as empty instead of throwing"

# ---- 6. the whole run loop: start a step, tail it, notice it exit -----------
#
# This is the exact pattern the build window uses, running the real Start-Shell
# from build-gui.ps1. The previous version relied on PowerShell event
# subscriptions, whose handlers never fire while a dialog is open — which is why
# the window sat on "Installing dependencies" forever.

$onWindows = $env:OS -eq 'Windows_NT'
$stdout = Join-Path $temp 'proc.log'
$command = if ($onWindows) { 'echo step-one& echo step-two' } else { 'echo step-one; sleep 0.3; echo step-two' }

$proc = Start-Shell $command $stdout $temp

$collected = ''
$opos = 0
$ticks = 0
$sawOutputWhileRunning = $false
while ($ticks -lt 150) {
  Start-Sleep -Milliseconds 100
  $ticks++
  $chunk = Read-NewText $stdout ([ref]$opos)
  if ($chunk) {
    $collected += $chunk
    if (-not $proc.HasExited) { $sawOutputWhileRunning = $true }
  }
  if ($proc.HasExited) {
    Start-Sleep -Milliseconds 150
    $collected += Read-NewText $stdout ([ref]$opos)
    break
  }
}

Check ($proc.HasExited) "the polling loop notices the process exit"
Check ($proc.ExitCode -eq 0) "a successful step reports exit code 0"
Check ($collected -match 'step-one') "the shell's redirected output is captured"
Check ($collected -match 'step-two') "later output is captured too"
Check ($sawOutputWhileRunning -or -not $onWindows) "output appears while the step is still running"

# a failing step must surface a non-zero code, which is what stops the queue
$failLog = Join-Path $temp 'fail.log'
$failCommand = if ($onWindows) { 'exit /b 3' } else { 'exit 3' }
$bad = Start-Shell $failCommand $failLog $temp
$bad.WaitForExit()
Check ($bad.ExitCode -eq 3) "a failing step reports its exit code"

# the working directory must be honoured, or npm runs in the wrong folder
$pwdLog = Join-Path $temp 'pwd.log'
$pwdCommand = if ($onWindows) { 'cd' } else { 'pwd' }
$where = Start-Shell $pwdCommand $pwdLog $temp
$where.WaitForExit()
Start-Sleep -Milliseconds 120
$reported = (Get-Content $pwdLog -Raw).Trim()
Check ($reported -and ((Resolve-Path $reported).Path -eq (Resolve-Path $temp).Path)) "the step runs in the project folder ($reported)"

# ---- 7. the original bug must not come back --------------------------------

$commands = $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)
$eventSubscriptions = @($commands | Where-Object {
    $_.GetCommandName() -in @('Register-ObjectEvent', 'Register-EngineEvent', 'Wait-Event')
  })
Check ($eventSubscriptions.Count -eq 0) "no PowerShell event subscriptions (their handlers never fire behind a dialog)"

$guiText = Get-Content $guiPath -Raw
Check ($guiText -match 'Windows\.Forms\.Timer') "uses a WinForms timer, which does keep ticking behind a dialog"
Check ($guiText -notmatch '-RedirectStandardOutput') "does not depend on .NET stream redirection"

# Set-Content -Encoding UTF8 writes a BOM on Windows PowerShell. Nothing in the
# script may use it on a file the packager parses.
$setContentCalls = @($commands | Where-Object { $_.GetCommandName() -eq 'Set-Content' })
Check ($setContentCalls.Count -eq 0) "no Set-Content (it adds a byte-order mark on Windows PowerShell)"

Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
