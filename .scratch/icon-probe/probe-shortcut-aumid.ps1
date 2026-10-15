param([string[]]$Targets)

# UTF-16LE byte pattern search: decoding from offset 0 misses strings that start on an odd byte.
function Test-Utf16Pattern([byte[]]$hay, [string]$needle) {
  $pat = [System.Text.Encoding]::Unicode.GetBytes($needle)
  for ($i = 0; $i -le $hay.Length - $pat.Length; $i++) {
    $ok = $true
    for ($j = 0; $j -lt $pat.Length; $j++) {
      if ($hay[$i + $j] -ne $pat[$j]) { $ok = $false; break }
    }
    if ($ok) { return $i }
  }
  return -1
}

function Test-AsciiPattern([byte[]]$hay, [string]$needle) {
  $pat = [System.Text.Encoding]::ASCII.GetBytes($needle)
  for ($i = 0; $i -le $hay.Length - $pat.Length; $i++) {
    $ok = $true
    for ($j = 0; $j -lt $pat.Length; $j++) {
      if ($hay[$i + $j] -ne $pat[$j]) { $ok = $false; break }
    }
    if ($ok) { return $i }
  }
  return -1
}

foreach ($t in $Targets) {
  if (-not (Test-Path $t)) { Write-Output ("MISSING " + $t); continue }
  $bytes = [System.IO.File]::ReadAllBytes($t)
  Write-Output ("file=" + $t + " bytes=" + $bytes.Length)
  foreach ($needle in @("org.ompbot.desktop", "org.ompbot.app", "org.ompbot.app.dev")) {
    $u = Test-Utf16Pattern $bytes $needle
    $a = Test-AsciiPattern $bytes $needle
    Write-Output ("   " + $needle + ": utf16Offset=" + $u + " asciiOffset=" + $a)
  }
  foreach ($needle in @("electron.exe", "omp-bot.exe", "omp-bot-0.1.0-portable.exe", "app-icon.ico")) {
    $u = Test-Utf16Pattern $bytes $needle
    $a = Test-AsciiPattern $bytes $needle
    Write-Output ("   " + $needle + ": utf16Offset=" + $u + " asciiOffset=" + $a)
  }
}
