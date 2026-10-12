$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security
$names = @('release/omp-bot-0.1.0-portable.exe','release/omp-bot-0.1.0-setup.exe','release/win-unpacked/omp-bot.exe','release/win-unpacked/resources/runtime/omp.exe')
$records = foreach ($name in $names) {
  $item = Get-Item -LiteralPath $name
  $stream = [System.IO.File]::OpenRead($item.FullName)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLower() } finally { $stream.Dispose(); $algorithm.Dispose() }
  $signature = Get-AuthenticodeSignature -LiteralPath $name
  [pscustomobject]@{ path=$name; bytes=$item.Length; sha256=$hash; signature=[string]$signature.Status }
}
[pscustomobject]@{ checkedAt=[DateTime]::UtcNow.ToString('o'); files=@($records) } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath '.scratch/omp-native-workbench/package-proof.json' -Encoding UTF8
$records | ConvertTo-Json -Compress
