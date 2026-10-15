$ErrorActionPreference = "Continue"

$targets = @()
$pinned = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
if (Test-Path $pinned) { $targets += (Get-ChildItem -Path $pinned -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
if (Test-Path $startMenu) { $targets += (Get-ChildItem -Path $startMenu -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
foreach ($folder in @((Join-Path $env:USERPROFILE "Desktop"), "C:\Users\Public\Desktop")) {
  if (Test-Path $folder) { $targets += (Get-ChildItem -Path $folder -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
}

Write-Output ("targets=" + $targets.Count)
foreach ($t in $targets) {
  $bytes = [System.IO.File]::ReadAllBytes($t)
  $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
  $utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
  $hasAumid = $utf16.Contains("org.ompbot.desktop") -or $ascii.Contains("org.ompbot.desktop")
  $isOmp = ($ascii.Contains("omp-bot") -or $utf16.Contains("omp-bot"))
  $isElectron = ($ascii.Contains("electron.exe") -or $utf16.Contains("electron.exe"))
  if (-not ($hasAumid -or $isOmp -or $isElectron)) { continue }
  $sh = New-Object -ComObject WScript.Shell
  $lnk = $sh.CreateShortcut($t)
  $kind = if ($t -like "*User Pinned\TaskBar*") { "TASKBAR-PIN" } else { "shortcut" }
  Write-Output ("[" + $kind + "] " + $t)
  Write-Output ("   target=" + $lnk.TargetPath)
  Write-Output ("   icon=" + $lnk.IconLocation + "  args=" + $lnk.Arguments)
  Write-Output ("   aumid=" + $hasAumid + " mentionsOmpBot=" + $isOmp + " mentionsElectron=" + $isElectron)
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($lnk)
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($sh)
}

Write-Output "=== Taskband Favorites ==="
try {
  $blob = (Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband" -Name Favorites -ErrorAction Stop).Favorites
  Write-Output ("blob bytes=" + $blob.Length)
  $text = [System.Text.Encoding]::Unicode.GetString($blob)
  foreach ($needle in @("org.ompbot.desktop", "electron.exe", "omp-bot.exe", "app-icon")) {
    $count = 0; $pos = 0
    while (($pos = $text.IndexOf($needle, $pos, [StringComparison]::OrdinalIgnoreCase)) -ge 0) { $count++; $pos += $needle.Length }
    Write-Output ("  " + $needle + " utf16 count=" + $count)
  }
} catch {
  Write-Output ("Favorites unreadable: " + $_.Exception.Message)
}
