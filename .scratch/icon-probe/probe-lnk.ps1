param(
  [Parameter(Mandatory=$true)][string]$Lnk,
  [int]$MinString = 4
)

$bytes = [System.IO.File]::ReadAllBytes($Lnk)
Write-Output ("file=" + $Lnk + " bytes=" + $bytes.Length)

# PKEY_GUID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3} serialized little-endian
$guid = [byte[]](0x55,0x28,0x4C,0x9F,0x79,0x9F,0x39,0x4B,0xA8,0xD0,0xE1,0xD4,0x2D,0xE1,0xD5,0xF3)
$propNames = @{ 2 = "RelaunchCommand"; 3 = "RelaunchIconResource"; 4 = "RelaunchDisplayNameResource"; 5 = "AppUserModelID"; 6 = "IsDestListSeparator"; 7 = "ExcludeFromShowInNewInstall"; 9 = "PreventPinning" }

function Find-All([byte[]]$hay, [byte[]]$needle) {
  $hits = New-Object System.Collections.Generic.List[int]
  for ($i = 0; $i -le $hay.Length - $needle.Length; $i++) {
    $ok = $true
    for ($j = 0; $j -lt $needle.Length; $j++) {
      if ($hay[$i + $j] -ne $needle[$j]) { $ok = $false; break }
    }
    if ($ok) { $hits.Add($i) }
  }
  return $hits
}

foreach ($hit in (Find-All $bytes $guid)) {
  $propid = 0
  if ($hit + 20 -le $bytes.Length) { $propid = [BitConverter]::ToUInt32($bytes, $hit + 16) }
  $name = $propNames[[int]$propid]
  if (-not $name) { $name = "propid=$propid" }
  $tail = [Math]::Min(220, $bytes.Length - $hit)
  $chunk = $bytes[$hit..($hit + $tail - 1)]
  $ascii = ($chunk | ForEach-Object { if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { "." } }) -join ""
  Write-Output ("PKEY @" + $hit + " -> " + $name)
  Write-Output ("   raw: " + $ascii)
  $text = [System.Text.Encoding]::Unicode.GetString($chunk)
  $prints = ($text -split "[^\u0020-\u007E]+") | Where-Object { $_.Length -ge 3 }
  if ($prints) { Write-Output ("   utf16 strings: " + ($prints -join " | ")) }
}

Write-Output "--- all utf16 strings (len>=$MinString) ---"
$all = [System.Text.Encoding]::Unicode.GetString($bytes)
$parts = ($all -split "[^\u0020-\u007E]+") | Where-Object { $_.Length -ge $MinString }
foreach ($p in $parts) { Write-Output ("   " + $p) }
