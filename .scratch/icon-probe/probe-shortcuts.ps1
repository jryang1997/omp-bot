param([switch]$SkipTaskband)

$ErrorActionPreference = "Stop"

function Get-ShortcutInfo([string]$path) {
  $info = [ordered]@{ file = $path }
  try {
    $sh = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($path)
    $info.target = $lnk.TargetPath
    $info.args = $lnk.Arguments
    $info.iconLocation = $lnk.IconLocation
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($lnk)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($sh)
  } catch {
    $info.target = "(unreadable: $($_.Exception.Message))"
  }
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
  $utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
  $info.aumidAscii = $ascii.Contains("org.ompbot.desktop")
  $info.aumidUtf16 = $utf16.Contains("org.ompbot.desktop")
  $info.mentionsElectron = ($ascii.Contains("electron.exe") -or $utf16.Contains("electron.exe"))
  $info.mentionsOmpBot = ($ascii.Contains("omp-bot.exe") -or $utf16.Contains("omp-bot.exe"))
  return $info
}

$roots = @(
  (Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
  $env:USERPROFILE,
  $env:PUBLIC
)

$files = New-Object System.Collections.Generic.List[string]
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { $files.Add($_.FullName) }
}
Get-ChildItem -Path "C:\Users\Public\Desktop" -Filter *.lnk -ErrorAction SilentlyContinue |
  ForEach-Object { $files.Add($_.FullName) }

Write-Output ("scanning " + $files.Count + " shortcuts")
foreach ($f in $files) {
  $i = Get-ShortcutInfo $f
  $isPinned = $f -like "*User Pinned\TaskBar*"
  Write-Output ("--- [" + $(if ($isPinned) { "taskbar-pin" } else { "shortcut" }) + "] " + $i.file)
  Write-Output ("    target=" + $i.target)
  Write-Output ("    iconLocation=" + $i.iconLocation + " args=" + $i.args)
  Write-Output ("    aumid(ascii/utf16)=" + $i.aumidAscii + "/" + $i.aumidUtf16 + " electron=" + $i.mentionsElectron + " ompbot=" + $i.mentionsOmpBot)
}

if (-not $SkipTaskband) {
  Write-Output "--- Taskband Favorites blob"
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Taskband"
  $blob = $null
  try { $blob = (Get-ItemProperty -Path $key -Name Favorites -ErrorAction Stop).Favorites } catch { }
  if ($null -eq $blob) {
    Write-Output "    Favorites value not readable"
  } else {
    $text = [System.Text.Encoding]::Unicode.GetString($blob)
    $ascii = [System.Text.Encoding]::ASCII.GetString($blob)
    foreach ($needle in @("org.ompbot.desktop", "electron.exe", "omp-bot", "electron")) {
      $countUtf16 = 0
      $pos = 0
      while (($pos = $text.IndexOf($needle, $pos, [StringComparison]::OrdinalIgnoreCase)) -ge 0) { $countUtf16++; $pos += $needle.Length }
      $countAscii = 0
      $pos = 0
      while (($pos = $ascii.IndexOf($needle, $pos, [StringComparison]::OrdinalIgnoreCase)) -ge 0) { $countAscii++; $pos += $needle.Length }
      Write-Output ("    " + $needle + ": utf16=" + $countUtf16 + " ascii=" + $countAscii)
    }
    Write-Output ("    blob bytes=" + $blob.Length)

    $start = 0
    while ($true) {
      $idx = $ascii.IndexOf("org.ompbot.desktop", $start, [StringComparison]::OrdinalIgnoreCase)
      if ($idx -lt 0) { break }
      $from = [Math]::Max(0, $idx - 160)
      $len = [Math]::Min(500, $blob.Length - $from)
      $chunk = [System.Text.Encoding]::ASCII.GetString($blob, $from, $len)
      $printable = ($chunk.ToCharArray() | ForEach-Object { if ([int]$_ -ge 32 -and [int]$_ -lt 127) { $_ } else { "." } }) -join ""
      Write-Output ("    context@" + $idx + ": " + $printable)
      $start = $idx + 1
    }
  }
}
