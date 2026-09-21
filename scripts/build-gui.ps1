<#
  FinFolio build helper — a small window that checks the prerequisites, sets the
  version number, builds the Windows installer and (optionally) publishes the
  release to GitHub.

  Launch it by double-clicking "Build FinFolio (GUI).bat" in the project folder.

  Implementation note: while a WinForms dialog is showing, PowerShell does not
  process its own event queue, so subscription-based output handlers never fire
  and the window appears to hang. Instead, each step lets the command shell
  redirect its own output to a file, and a WinForms timer — which runs on the UI
  thread and does keep ticking — tails that file and watches for the process to
  exit.
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$script:Steps      = New-Object System.Collections.Generic.Queue[object]
$script:Proc       = $null
$script:OutFile    = $null
$script:OutPos     = 0
$script:Busy       = $false
$script:StartedAt  = $null
$script:TempDir    = Join-Path ([System.IO.Path]::GetTempPath()) ("finfolio-build-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
[void](New-Item -ItemType Directory -Path $script:TempDir -Force)

# ---------------------------------------------------------------- helpers ---

# package.json must stay plain UTF-8 with no byte-order mark. Windows
# PowerShell's Set-Content -Encoding UTF8 writes one, and electron-builder
# parses the file itself with JSON.parse, which rejects a leading BOM with
# "Unexpected token '﻿'". So read past any BOM and always write without one.
function Read-TextNoBom([string]$file) {
  return [System.IO.File]::ReadAllText($file).TrimStart([char]0xFEFF)
}

function Write-TextNoBom([string]$file, [string]$text) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($file, $text, $utf8NoBom)
}

function Get-AppVersion {
  try { (Read-TextNoBom (Join-Path $root 'package.json') | ConvertFrom-Json).version }
  catch { '0.0.0' }
}

function Set-AppVersion([string]$version) {
  $file = Join-Path $root 'package.json'
  $text = Read-TextNoBom $file
  $text = [regex]::Replace($text, '("version"\s*:\s*")[^"]+(")', "`${1}$version`${2}", 1)
  Write-TextNoBom $file $text
}

# Repair a package.json (or lockfile) that an earlier build left with a BOM.
function Repair-PackageJson {
  $repaired = @()
  foreach ($name in @('package.json', 'package-lock.json')) {
    $file = Join-Path $root $name
    if (-not (Test-Path $file)) { continue }
    $bytes = [System.IO.File]::ReadAllBytes($file)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
      Write-TextNoBom $file (Read-TextNoBom $file)
      $repaired += $name
    }
  }
  return $repaired
}

function Bump([string]$version, [string]$part) {
  $p = $version -split '\.'
  if ($p.Count -lt 3) { $p = @('1', '0', '0') }
  switch ($part) {
    'major' { "$([int]$p[0] + 1).0.0" }
    'minor' { "$($p[0]).$([int]$p[1] + 1).0" }
    default { "$($p[0]).$($p[1]).$([int]$p[2] + 1)" }
  }
}

function Test-Dependencies {
  Test-Path (Join-Path $root 'node_modules\electron\package.json')
}

# --------------------------------------------------------------- the form ---

$form               = New-Object System.Windows.Forms.Form
$form.Text          = 'FinFolio - Build the Windows installer'
$form.Size          = New-Object System.Drawing.Size(880, 680)
$form.StartPosition = 'CenterScreen'
$form.MinimumSize   = New-Object System.Drawing.Size(780, 600)
$form.BackColor     = [System.Drawing.Color]::FromArgb(246, 247, 250)
$form.Font          = New-Object System.Drawing.Font('Segoe UI', 9.5)

$iconPath = Join-Path $root 'build\icon.ico'
if (Test-Path $iconPath) { try { $form.Icon = New-Object System.Drawing.Icon($iconPath) } catch {} }

# header ---------------------------------------------------------------------
$header           = New-Object System.Windows.Forms.Panel
$header.Dock      = 'Top'
$header.Height    = 68
$header.BackColor = [System.Drawing.Color]::White
$form.Controls.Add($header)

$title           = New-Object System.Windows.Forms.Label
$title.Text      = 'FinFolio'
$title.Font      = New-Object System.Drawing.Font('Segoe UI Semibold', 15)
$title.ForeColor = [System.Drawing.Color]::FromArgb(21, 23, 31)
$title.Location  = New-Object System.Drawing.Point(20, 12)
$title.AutoSize  = $true
$header.Controls.Add($title)

$subtitle           = New-Object System.Windows.Forms.Label
$subtitle.Text      = 'Build the installer, then share or install it.'
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(86, 93, 110)
$subtitle.Location  = New-Object System.Drawing.Point(22, 40)
$subtitle.AutoSize  = $true
$header.Controls.Add($subtitle)

$statusLabel           = New-Object System.Windows.Forms.Label
$statusLabel.Text      = 'Checking...'
$statusLabel.TextAlign = 'MiddleRight'
$statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(86, 93, 110)
$statusLabel.Size      = New-Object System.Drawing.Size(440, 40)
$statusLabel.Location  = New-Object System.Drawing.Point(400, 16)
$statusLabel.Anchor    = 'Top,Right'
$header.Controls.Add($statusLabel)

# options --------------------------------------------------------------------
$options          = New-Object System.Windows.Forms.GroupBox
$options.Text     = ' Options '
$options.Location = New-Object System.Drawing.Point(18, 82)
$options.Size     = New-Object System.Drawing.Size(826, 150)
$options.Anchor   = 'Top,Left,Right'
$form.Controls.Add($options)

$verLabel          = New-Object System.Windows.Forms.Label
$verLabel.Text     = 'Version'
$verLabel.Location = New-Object System.Drawing.Point(16, 30)
$verLabel.AutoSize = $true
$options.Controls.Add($verLabel)

$verBox          = New-Object System.Windows.Forms.TextBox
$verBox.Location = New-Object System.Drawing.Point(80, 26)
$verBox.Size     = New-Object System.Drawing.Size(110, 26)
$verBox.Text     = Get-AppVersion
$options.Controls.Add($verBox)

$bumpPatch          = New-Object System.Windows.Forms.Button
$bumpPatch.Text     = 'Patch +'
$bumpPatch.Location = New-Object System.Drawing.Point(198, 25)
$bumpPatch.Size     = New-Object System.Drawing.Size(74, 27)
$options.Controls.Add($bumpPatch)

$bumpMinor          = New-Object System.Windows.Forms.Button
$bumpMinor.Text     = 'Minor +'
$bumpMinor.Location = New-Object System.Drawing.Point(276, 25)
$bumpMinor.Size     = New-Object System.Drawing.Size(74, 27)
$options.Controls.Add($bumpMinor)

$bumpMajor          = New-Object System.Windows.Forms.Button
$bumpMajor.Text     = 'Major +'
$bumpMajor.Location = New-Object System.Drawing.Point(354, 25)
$bumpMajor.Size     = New-Object System.Drawing.Size(74, 27)
$options.Controls.Add($bumpMajor)

$verHint           = New-Object System.Windows.Forms.Label
$verHint.Text      = 'Users only receive an update when this number goes up.'
$verHint.ForeColor = [System.Drawing.Color]::FromArgb(134, 141, 160)
$verHint.Location  = New-Object System.Drawing.Point(440, 31)
$verHint.AutoSize  = $true
$options.Controls.Add($verHint)

$chkTests          = New-Object System.Windows.Forms.CheckBox
$chkTests.Text     = 'Run the checks and tests before building (recommended)'
$chkTests.Location = New-Object System.Drawing.Point(18, 64)
$chkTests.Size     = New-Object System.Drawing.Size(420, 24)
$chkTests.Checked  = $true
$options.Controls.Add($chkTests)

$chkPublish          = New-Object System.Windows.Forms.CheckBox
$chkPublish.Text     = 'Publish to GitHub Releases (sends the update to users)'
$chkPublish.Location = New-Object System.Drawing.Point(18, 92)
$chkPublish.Size     = New-Object System.Drawing.Size(420, 24)
$options.Controls.Add($chkPublish)

$tokenLabel          = New-Object System.Windows.Forms.Label
$tokenLabel.Text     = 'GitHub token'
$tokenLabel.Location = New-Object System.Drawing.Point(440, 95)
$tokenLabel.AutoSize = $true
$tokenLabel.Enabled  = $false
$options.Controls.Add($tokenLabel)

$tokenBox                       = New-Object System.Windows.Forms.TextBox
$tokenBox.Location              = New-Object System.Drawing.Point(524, 91)
$tokenBox.Size                  = New-Object System.Drawing.Size(280, 26)
$tokenBox.UseSystemPasswordChar = $true
$tokenBox.Enabled               = $false
$tokenBox.Anchor                = 'Top,Left,Right'
$options.Controls.Add($tokenBox)

$tokenHint           = New-Object System.Windows.Forms.Label
$tokenHint.Text      = 'Leave blank to use the GH_TOKEN environment variable.'
$tokenHint.ForeColor = [System.Drawing.Color]::FromArgb(134, 141, 160)
$tokenHint.Location  = New-Object System.Drawing.Point(440, 120)
$tokenHint.AutoSize  = $true
$options.Controls.Add($tokenHint)

# buttons --------------------------------------------------------------------
$btnInstall          = New-Object System.Windows.Forms.Button
$btnInstall.Text     = 'Install / update dependencies'
$btnInstall.Location = New-Object System.Drawing.Point(18, 244)
$btnInstall.Size     = New-Object System.Drawing.Size(210, 38)
$form.Controls.Add($btnInstall)

$btnBuild           = New-Object System.Windows.Forms.Button
$btnBuild.Text      = 'Build the installer'
$btnBuild.Location  = New-Object System.Drawing.Point(238, 244)
$btnBuild.Size      = New-Object System.Drawing.Size(190, 38)
$btnBuild.BackColor = [System.Drawing.Color]::FromArgb(91, 91, 214)
$btnBuild.ForeColor = [System.Drawing.Color]::White
$btnBuild.FlatStyle = 'Flat'
$btnBuild.FlatAppearance.BorderSize = 0
$btnBuild.Font      = New-Object System.Drawing.Font('Segoe UI Semibold', 10)
$form.Controls.Add($btnBuild)

$btnRun          = New-Object System.Windows.Forms.Button
$btnRun.Text     = 'Test run the app'
$btnRun.Location = New-Object System.Drawing.Point(438, 244)
$btnRun.Size     = New-Object System.Drawing.Size(150, 38)
$form.Controls.Add($btnRun)

$btnOpen          = New-Object System.Windows.Forms.Button
$btnOpen.Text     = 'Open output folder'
$btnOpen.Location = New-Object System.Drawing.Point(598, 244)
$btnOpen.Size     = New-Object System.Drawing.Size(150, 38)
$form.Controls.Add($btnOpen)

$btnStop           = New-Object System.Windows.Forms.Button
$btnStop.Text      = 'Stop'
$btnStop.Location  = New-Object System.Drawing.Point(758, 244)
$btnStop.Size      = New-Object System.Drawing.Size(86, 38)
$btnStop.Enabled   = $false
$btnStop.Anchor    = 'Top,Right'
$form.Controls.Add($btnStop)

$progress          = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(18, 292)
$progress.Size     = New-Object System.Drawing.Size(826, 6)
$progress.Style    = 'Marquee'
$progress.Visible  = $false
$progress.Anchor   = 'Top,Left,Right'
$form.Controls.Add($progress)

# log ------------------------------------------------------------------------
$log             = New-Object System.Windows.Forms.RichTextBox
$log.Location    = New-Object System.Drawing.Point(18, 306)
$log.Size        = New-Object System.Drawing.Size(826, 300)
$log.Anchor      = 'Top,Bottom,Left,Right'
$log.ReadOnly    = $true
$log.BackColor   = [System.Drawing.Color]::FromArgb(23, 25, 34)
$log.ForeColor   = [System.Drawing.Color]::FromArgb(208, 213, 226)
$log.Font        = New-Object System.Drawing.Font('Consolas', 9)
$log.BorderStyle = 'None'
$log.WordWrap    = $false
$form.Controls.Add($log)

$footer           = New-Object System.Windows.Forms.Label
$footer.Text      = 'Tip: the first build downloads Electron (about 150 MB) and can take several minutes.'
$footer.ForeColor = [System.Drawing.Color]::FromArgb(134, 141, 160)
$footer.Location  = New-Object System.Drawing.Point(20, 614)
$footer.AutoSize  = $true
$footer.Anchor    = 'Bottom,Left'
$form.Controls.Add($footer)

function Append([string]$text, [string]$kind = 'info') {
  $color = switch ($kind) {
    'ok'   { [System.Drawing.Color]::FromArgb(110, 220, 140) }
    'err'  { [System.Drawing.Color]::FromArgb(240, 133, 133) }
    'warn' { [System.Drawing.Color]::FromArgb(243, 183, 63) }
    'head' { [System.Drawing.Color]::FromArgb(156, 156, 245) }
    default { [System.Drawing.Color]::FromArgb(168, 174, 192) }
  }
  # Keep the control from growing without bound during a long npm install.
  if ($log.Lines.Count -gt 4000) {
    $log.Text = ($log.Lines | Select-Object -Last 2000) -join "`r`n"
  }
  $log.SelectionStart  = $log.TextLength
  $log.SelectionLength = 0
  $log.SelectionColor  = $color
  $log.AppendText("$text`r`n")
  $log.SelectionColor  = $log.ForeColor
  $log.SelectionStart  = $log.TextLength
  $log.ScrollToCaret()
}

function Set-Enabled([bool]$on) {
  foreach ($c in @($btnInstall, $btnBuild, $btnRun, $verBox, $bumpPatch, $bumpMinor, $bumpMajor, $chkTests, $chkPublish)) {
    $c.Enabled = $on
  }
  $btnStop.Enabled = -not $on
  if ($on) {
    $tokenBox.Enabled   = $chkPublish.Checked
    $tokenLabel.Enabled = $chkPublish.Checked
  } else {
    $tokenBox.Enabled = $false
  }
}

# ------------------------------------------------------------- step runner ---

function Add-Step([string]$label, [string]$command) {
  $script:Steps.Enqueue([pscustomobject]@{ Label = $label; Command = $command })
}

function Read-NewText([string]$path, [ref]$position) {
  if (-not (Test-Path $path)) { return '' }
  try {
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  } catch {
    return ''
  }
  try {
    if ($stream.Length -le $position.Value) { return '' }
    [void]$stream.Seek($position.Value, [System.IO.SeekOrigin]::Begin)
    $reader = New-Object System.IO.StreamReader($stream)
    $text = $reader.ReadToEnd()
    $position.Value = $stream.Length
    return $text
  } catch {
    return ''
  } finally {
    $stream.Dispose()
  }
}

# Runs a command through the system shell, letting the shell redirect its own
# output to $outFile. Nothing relies on .NET stream redirection, which behaves
# differently across PowerShell versions. The non-Windows branch exists only so
# this can be exercised by scripts/test-build-gui.ps1.
function Start-Shell([string]$command, [string]$outFile, [string]$workingDirectory) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  # The command is wrapped in a group so the redirect captures every part of it,
  # not just the last one in a chain.
  if ($env:OS -eq 'Windows_NT') {
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = "/c ($command) > `"$outFile`" 2>&1"
  } else {
    $psi.FileName = '/bin/sh'
    $psi.Arguments = "-c `"{ $command ; } > '$outFile' 2>&1`""
  }
  $psi.WorkingDirectory = $workingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  return [System.Diagnostics.Process]::Start($psi)
}

function Drain-Output {
  if (-not $script:OutFile) { return }
  $text = Read-NewText $script:OutFile ([ref]$script:OutPos)
  if (-not $text) { return }
  foreach ($line in ($text -split "`r?`n")) {
    if ($line.Trim().Length -eq 0) { continue }
    $kind = 'info'
    if ($line -match '^\s*(npm ERR!|Error:|error |ERROR)') { $kind = 'err' }
    elseif ($line -match '^\s*(npm WARN|warning|WARN)') { $kind = 'warn' }
    Append ("  " + $line.TrimEnd()) $kind
  }
}

function Start-NextStep {
  if ($script:Steps.Count -eq 0) {
    $script:Busy = $false
    $script:Proc = $null
    $progress.Visible = $false
    Set-Enabled $true
    Append ''
    Append 'All done.' 'ok'
    $dist = Join-Path $root 'dist'
    if (Test-Path $dist) {
      foreach ($f in Get-ChildItem $dist -Filter *.exe -ErrorAction SilentlyContinue) {
        Append ("  " + $f.Name + "   " + [math]::Round($f.Length / 1MB, 1) + " MB") 'ok'
      }
      Append 'Press "Open output folder" to find them.' 'info'
    }
    return
  }

  $step = $script:Steps.Dequeue()
  Append ''
  Append "> $($step.Label)" 'head'

  $stamp = [guid]::NewGuid().ToString('N').Substring(0, 6)
  $script:OutFile = Join-Path $script:TempDir "$stamp.log"
  $script:OutPos = 0

  try {
    $script:StartedAt = Get-Date
    $script:Proc = Start-Shell $step.Command $script:OutFile $root
  } catch {
    Append "  Could not start the step: $($_.Exception.Message)" 'err'
    Stop-Everything
    return
  }
}

function Stop-Everything {
  $script:Steps.Clear()
  if ($script:Proc -and -not $script:Proc.HasExited) {
    try {
      if ($env:OS -eq 'Windows_NT') {
        # Kill the whole tree — cmd.exe is only the parent of npm/node.
        & taskkill.exe /PID $script:Proc.Id /T /F 2>&1 | Out-Null
      } else {
        $script:Proc.Kill()
      }
    } catch {}
  }
  $script:Proc = $null
  $script:Busy = $false
  $progress.Visible = $false
  Set-Enabled $true
}

# The timer runs on the UI thread, so it keeps ticking while the window is open.
$timer          = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    if (-not $script:Proc) { return }
    Drain-Output
    if ($script:Proc.HasExited) {
      Start-Sleep -Milliseconds 120
      Drain-Output
      $code = $script:Proc.ExitCode
      $seconds = [math]::Round(((Get-Date) - $script:StartedAt).TotalSeconds)
      $script:Proc = $null
      if ($code -eq 0) {
        Append "  finished in ${seconds}s" 'ok'
        Start-NextStep
      } else {
        Append "  FAILED (exit code $code) after ${seconds}s" 'err'
        Append ''
        Append 'The build stopped. Common fixes:' 'warn'
        Append '  - Close any running copy of FinFolio, then try again' 'warn'
        Append '  - Delete the node_modules folder and press Install / update dependencies' 'warn'
        Stop-Everything
      }
    }
  })
$timer.Start()

# -------------------------------------------------------------- behaviour ---

$chkPublish.Add_CheckedChanged({
    $tokenBox.Enabled   = $chkPublish.Checked
    $tokenLabel.Enabled = $chkPublish.Checked
  })

$bumpPatch.Add_Click({ $verBox.Text = Bump $verBox.Text 'patch' })
$bumpMinor.Add_Click({ $verBox.Text = Bump $verBox.Text 'minor' })
$bumpMajor.Add_Click({ $verBox.Text = Bump $verBox.Text 'major' })

$btnStop.Add_Click({
    if (-not $script:Busy) { return }
    Append ''
    Append 'Stopped.' 'warn'
    Stop-Everything
  })

$btnInstall.Add_Click({
    if ($script:Busy) { return }
    $script:Busy = $true
    Set-Enabled $false
    $progress.Visible = $true
    Add-Step 'Installing dependencies (downloads about 150 MB the first time)' 'npm install --no-audit --no-fund'
    Start-NextStep
  })

$btnRun.Add_Click({
    if ($script:Busy) { return }
    if (-not (Test-Dependencies)) {
      [System.Windows.Forms.MessageBox]::Show('Install the dependencies first.', 'FinFolio', 'OK', 'Information') | Out-Null
      return
    }
    Append ''
    Append '> Starting FinFolio (close its window when you are done)' 'head'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start' -WorkingDirectory $root -WindowStyle Hidden
  })

$btnOpen.Add_Click({
    $dist = Join-Path $root 'dist'
    if (Test-Path $dist) { Start-Process explorer.exe $dist }
    else { [System.Windows.Forms.MessageBox]::Show('Nothing has been built yet.', 'FinFolio', 'OK', 'Information') | Out-Null }
  })

$btnBuild.Add_Click({
    if ($script:Busy) { return }

    # Self-heal a file an older version of this script may have damaged.
    foreach ($fixed in Repair-PackageJson) {
      Append "Removed a stray byte-order mark from $fixed" 'warn'
    }

    $version = $verBox.Text.Trim()
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
      [System.Windows.Forms.MessageBox]::Show("The version must look like 1.2.3 (you typed '$version').", 'FinFolio', 'OK', 'Warning') | Out-Null
      return
    }
    if ($version -ne (Get-AppVersion)) {
      Set-AppVersion $version
      Append "Version set to $version" 'ok'
    }

    if ($chkPublish.Checked) {
      $token = $tokenBox.Text.Trim()
      if (-not $token) { $token = $env:GH_TOKEN }
      if (-not $token) {
        [System.Windows.Forms.MessageBox]::Show(
          "Publishing needs a GitHub personal access token with 'repo' permission." + [Environment]::NewLine + [Environment]::NewLine +
          'Create one at github.com > Settings > Developer settings > Personal access tokens, then paste it into the token box.',
          'FinFolio', 'OK', 'Warning') | Out-Null
        return
      }
      # Child processes inherit this, which is how electron-builder receives it.
      $env:GH_TOKEN = $token
    }

    $script:Busy = $true
    Set-Enabled $false
    $progress.Visible = $true
    $log.Clear()
    Append "Building FinFolio $version" 'head'

    if (-not (Test-Dependencies)) {
      Add-Step 'Installing dependencies (downloads about 150 MB the first time)' 'npm install --no-audit --no-fund'
    }
    if ($chkTests.Checked) {
      Add-Step 'Checking the source' 'npm run check'
      Add-Step 'Running the tests' 'npm test'
    }
    if ($chkPublish.Checked) {
      Add-Step 'Building and publishing to GitHub Releases' 'npm run release'
    } else {
      Add-Step 'Building the Windows installer' 'npm run dist'
    }
    Start-NextStep
  })

$form.Add_FormClosing({
    if ($script:Busy -and $script:Proc -and -not $script:Proc.HasExited) {
      $answer = [System.Windows.Forms.MessageBox]::Show('A build is still running. Stop it and close?', 'FinFolio', 'YesNo', 'Question')
      if ($answer -eq 'No') { $_.Cancel = $true; return }
    }
    $timer.Stop()
    Stop-Everything
    try { Remove-Item $script:TempDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
  })

# -------------------------------------------------------------- first run ---

$form.Add_Shown({
    Append 'FinFolio build helper' 'head'

    foreach ($fixed in Repair-PackageJson) {
      Append "Repaired $fixed (it had a stray byte-order mark)." 'warn'
    }
    $verBox.Text = Get-AppVersion

    $nodeVersion = $null
    try { $nodeVersion = (& node -v 2>$null | Select-Object -First 1) } catch {}

    if (-not $nodeVersion) {
      $statusLabel.Text = 'Node.js not found'
      $statusLabel.ForeColor = [System.Drawing.Color]::FromArgb(198, 47, 47)
      Append 'Node.js was not found on this PC.' 'err'
      Append 'Install the LTS version from https://nodejs.org, then close and reopen this window.' 'warn'
      Append '(A window that was already open cannot see a program installed after it started.)' 'warn'
      $btnBuild.Enabled = $false
      $btnInstall.Enabled = $false
      $btnRun.Enabled = $false
      return
    }

    $deps = Test-Dependencies
    $statusLabel.Text = "Node.js $nodeVersion   -   dependencies: $(if ($deps) { 'installed' } else { 'not installed yet' })"
    Append "Node.js $nodeVersion detected." 'ok'
    if ($deps) {
      Append 'Dependencies are installed. Press "Build the installer" when ready.'
    } else {
      Append 'Dependencies are not installed yet - the build installs them automatically.' 'warn'
      Append 'Output appears below as each step runs; the first one is the slowest.'
    }
  })

[void]$form.ShowDialog()
$timer.Dispose()
$form.Dispose()
