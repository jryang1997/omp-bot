param(
  [string]$WindowMatch = "",
  [string]$Exe = "",
  [int]$TimeoutSeconds = 20
)

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class IcoProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int index);

  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO info);
  [DllImport("gdi32.dll")] public static extern IntPtr GetObjectW(IntPtr h, int size, IntPtr data);
  [DllImport("gdi32.dll")] public static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, byte[] bits, ref BITMAPINFO bmi, uint usage);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, EntryPoint="ExtractIconExW")] public static extern int ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, int count);

  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAP { public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes; public short bmPlanes; public short bmBitsPixel; public IntPtr bmBits; }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount;
    public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
    public uint biClrUsed; public uint biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public uint bmiColors; }

  public static string Hash(byte[] data) {
    using (var sha = System.Security.Cryptography.SHA256.Create()) {
      var h = sha.ComputeHash(data);
      var sb = new StringBuilder();
      for (int i = 0; i < 16; i++) sb.Append(h[i].ToString("x2"));
      return sb.ToString();
    }
  }

  public static string DescribeIcon(IntPtr hIcon) {
    if (hIcon == IntPtr.Zero) return "null";
    ICONINFO info;
    if (!GetIconInfo(hIcon, out info)) return "GetIconInfo failed err=" + Marshal.GetLastWin32Error();
    if (info.hbmColor == IntPtr.Zero) return "no color bitmap";
    var bm = new BITMAP();
    IntPtr tmp = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BITMAP)));
    try {
      if (GetObjectW(info.hbmColor, Marshal.SizeOf(typeof(BITMAP)), tmp) == IntPtr.Zero) return "GetObject failed";
      bm = (BITMAP)Marshal.PtrToStructure(tmp, typeof(BITMAP));
    } finally { Marshal.FreeHGlobal(tmp); }
    var bmi = new BITMAPINFO();
    bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
    bmi.bmiHeader.biWidth = bm.bmWidth;
    bmi.bmiHeader.biHeight = bm.bmHeight;
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0;
    var bits = new byte[bm.bmWidth * Math.Abs(bm.bmHeight) * 4];
    IntPtr hdc = GetDC(IntPtr.Zero);
    int lines;
    try { lines = GetDIBits(hdc, info.hbmColor, 0, (uint)Math.Abs(bm.bmHeight), bits, ref bmi, 0); }
    finally { ReleaseDC(IntPtr.Zero, hdc); }
    var payload = new byte[8 + bits.Length];
    BitConverter.GetBytes(bm.bmWidth).CopyTo(payload, 0);
    BitConverter.GetBytes(bm.bmHeight).CopyTo(payload, 4);
    bits.CopyTo(payload, 8);
    return bm.bmWidth + "x" + bm.bmHeight + " bpp=" + bm.bmBitsPixel + " lines=" + lines + " sha256_16=" + Hash(payload);
  }

  public static List<IntPtr> Find(string match) {
    var local = new List<IntPtr>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) local.Add(h);
      return true;
    }, IntPtr.Zero);
    return local;
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop

$WM_GETICON = 0x007F
$GCLP_HICON = -14
$GCLP_HICONSM = -34

if ($WindowMatch -ne "") {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $handles = New-Object 'System.Collections.Generic.List[IntPtr]'
  while ((Get-Date) -lt $deadline) {
    $handles = [IcoProbe]::Find($WindowMatch)
    if ($handles.Count -gt 0) { break }
    Start-Sleep -Milliseconds 300
  }
  if ($handles.Count -eq 0) { Write-Output "window not found: $WindowMatch"; exit 2 }
  foreach ($h in $handles) {
    $sb = New-Object System.Text.StringBuilder 512
    [IcoProbe]::GetWindowTextW($h, $sb, 512) | Out-Null
    $pid2 = 0
    [IcoProbe]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
    $proc = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
    Write-Output ("window hwnd=0x" + $h.ToInt64().ToString("x") + " pid=$pid2 proc=$proc title=" + $sb.ToString())
    $map = @{ "WM_GETICON ICON_SMALL" = 0; "WM_GETICON ICON_BIG" = 1; "WM_GETICON ICON_SMALL2" = 2 }
    foreach ($k in $map.Keys) {
      $icon = [IcoProbe]::SendMessageW($h, $WM_GETICON, [IntPtr]$map[$k], [IntPtr]::Zero)
      Write-Output ("  ${k}: h=0x" + $icon.ToInt64().ToString("x") + " " + [IcoProbe]::DescribeIcon($icon))
    }
    $classBig = [IcoProbe]::GetClassLongPtr($h, $GCLP_HICON)
    $classSmall = [IcoProbe]::GetClassLongPtr($h, $GCLP_HICONSM)
    Write-Output ("  class HICON: " + [IcoProbe]::DescribeIcon($classBig))
    Write-Output ("  class HICONSM: " + [IcoProbe]::DescribeIcon($classSmall))
  }
}

if ($Exe -ne "") {
  Write-Output ("exe icons: " + $Exe)
  $large = New-Object 'IntPtr[]' 32
  $small = New-Object 'IntPtr[]' 32
  $count = [IcoProbe]::ExtractIconEx($Exe, -1, $null, $null, 0)
  Write-Output ("  ExtractIconEx count=$count")
  for ($i = 0; $i -lt [Math]::Min($count, 8); $i++) {
    $l = New-Object 'IntPtr[]' 1
    $s = New-Object 'IntPtr[]' 1
    [IcoProbe]::ExtractIconEx($Exe, $i, $l, $s, 1) | Out-Null
    Write-Output ("  index $i large: " + [IcoProbe]::DescribeIcon($l[0]))
    Write-Output ("  index $i small: " + [IcoProbe]::DescribeIcon($s[0]))
  }
}
