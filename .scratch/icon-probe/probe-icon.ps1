param([Parameter(Mandatory=$true)][string]$Exe)

$src = @'
using System;
using System.Runtime.InteropServices;
public class NativeRes {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr LoadLibraryEx(string name, IntPtr h, uint flags);
  [DllImport("kernel32.dll", SetLastError=true, EntryPoint="FindResourceW", CharSet=CharSet.Unicode)]
  public static extern IntPtr FindResource(IntPtr h, IntPtr name, IntPtr type);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr LoadResource(IntPtr h, IntPtr res);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr LockResource(IntPtr res);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint SizeofResource(IntPtr h, IntPtr res);
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop

$h = [NativeRes]::LoadLibraryEx($Exe, [IntPtr]::Zero, 0x00000002)  # LOAD_LIBRARY_AS_DATAFILE
if ($h -eq [IntPtr]::Zero) {
  Write-Output ("LoadLibraryEx failed: " + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
  exit 1
}

function Get-ResBytes([IntPtr]$module, [int]$id, [int]$typeId) {
  $res = [NativeRes]::FindResource($module, [IntPtr]$id, [IntPtr]$typeId)
  if ($res -eq [IntPtr]::Zero) { return $null }
  $size = [NativeRes]::SizeofResource($module, $res)
  $lr = [NativeRes]::LoadResource($module, $res)
  $ptr = [NativeRes]::LockResource($lr)
  $buf = New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($ptr, $buf, 0, $size)
  return $buf
}

function Get-Sha([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return (-join ($sha | ForEach-Object { $_.ToString('x2') }))
}

Write-Output ("exe: " + $Exe)
$groupIds = @()
foreach ($id in 1..8) {
  $buf = Get-ResBytes $h $id 14
  if ($null -eq $buf) { continue }
  $groupIds += $id
  $n = [BitConverter]::ToUInt16($buf, 4)
  $parts = @()
  for ($i = 0; $i -lt $n; $i++) {
    $o = 6 + $i * 14
    $w = [int]$buf[$o]; if ($w -eq 0) { $w = 256 }
    $hh = [int]$buf[$o + 1]; if ($hh -eq 0) { $hh = 256 }
    $parts += ($w.ToString() + 'x' + $hh + ':' + [BitConverter]::ToUInt32($buf, $o + 8) + 'B')
  }
  Write-Output ("RT_GROUP_ICON id=" + $id + " bytes=" + $buf.Length + " entries=" + $n + " " + ($parts -join ' '))
}
if ($groupIds.Count -eq 0) { Write-Output "RT_GROUP_ICON: none found" }

$iconIds = @()
foreach ($id in 1..20) {
  $buf = Get-ResBytes $h $id 3
  if ($null -eq $buf) { continue }
  $iconIds += $id
  $head = -join ($buf[0..7] | ForEach-Object { $_.ToString('x2') })
  Write-Output ("RT_ICON id=" + $id + " bytes=" + $buf.Length + " head=" + $head + " sha=" + (Get-Sha $buf).Substring(0, 16))
}
if ($iconIds.Count -eq 0) { Write-Output "RT_ICON: none found" }
