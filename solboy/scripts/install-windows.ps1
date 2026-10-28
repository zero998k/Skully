# One-line SolBoy install/upgrade for Windows. Paste into PowerShell:
#   irm https://raw.githubusercontent.com/zero998k/Skully/claude/hopeful-edison-2b8ltm/solboy/scripts/install-windows.ps1 | iex
# Finds your SolBoy folder (keeping your keys, wallets, settings and trades), puts the newest SolBoy in it,
# adds a desktop shortcut and opens it. Without an existing folder, it sets SolBoy up in Documents\SolBoy.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # makes downloads much faster in Windows PowerShell
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $base = 'https://github.com/zero998k/Skully/releases/latest/download'
  $asset = 'SolBoy-Windows.exe'
  function Say($text) { Write-Host ''; Write-Host $text -ForegroundColor Magenta }

  # Where is SolBoy now? A running copy first, then the usual folders.
  $dir = $null
  $running = Get-Process -Name SolBoy -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  if ($running -and (Test-Path (Join-Path (Split-Path $running.Path) 'config.json'))) { $dir = Split-Path $running.Path }
  if (-not $dir) {
    $docs = [Environment]::GetFolderPath('MyDocuments')
    $desk = [Environment]::GetFolderPath('Desktop')
    foreach ($d in @("$docs\SolBoy", "$desk\SolBoy", "$env:USERPROFILE\Downloads\SolBoy", "$env:USERPROFILE\Downloads\SolBoy-for-Windows\SolBoy", "$env:USERPROFILE\SolBoy")) {
      if ((Test-Path "$d\SolBoy.exe") -and (Test-Path "$d\config.json")) { $dir = $d; break }
    }
  }
  if ($dir) { Say "Found your SolBoy in $dir. Upgrading it (your keys, wallets and trades stay)." }
  else {
    $dir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'SolBoy'
    Say "Installing SolBoy in $dir"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }

  $tmp = Join-Path $dir 'SolBoy.new.exe'
  Write-Host 'Downloading SolBoy (about 110 MB)...'
  try { Invoke-WebRequest -Uri "$base/$asset" -OutFile $tmp -UseBasicParsing }
  catch { Write-Host "Couldn't download SolBoy. Check your internet and try again." -ForegroundColor Red; return }

  # Make sure the download is complete and untouched.
  $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $want = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($asset))\s*$" } | ForEach-Object { ($_ -split '\s+')[0] } | Select-Object -First 1)
  $got = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash
  if (-not $want -or $want.ToLower() -ne $got.ToLower()) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Host 'The download was damaged. Nothing was changed. Try again.' -ForegroundColor Red; return
  }
  Unblock-File -Path $tmp # downloaded by you on purpose: skip the "Windows protected your PC" warning
  $version = (& $tmp --version 2>$null | Out-String).Trim()
  if ($version -notmatch '^SolBoy \d') {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Host "The new SolBoy wouldn't start. Nothing was changed." -ForegroundColor Red; return
  }

  # Close the old SolBoy (if open), swap in the new one.
  Get-Process -Name SolBoy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $exe = Join-Path $dir 'SolBoy.exe'
  if (Test-Path $exe) { Remove-Item $exe -Force }
  Move-Item -Path $tmp -Destination $exe

  # A desktop shortcut so it's easy to open next time.
  try {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SolBoy.lnk'))
    $link.TargetPath = $exe; $link.WorkingDirectory = $dir; $link.Save()
  } catch {}

  Say "Done! $version is ready. Opening it now..."
  Write-Host 'A black window opens. The first time, it asks a few questions (your free Helius key first).'
  Start-Process -FilePath $exe -WorkingDirectory $dir
}
