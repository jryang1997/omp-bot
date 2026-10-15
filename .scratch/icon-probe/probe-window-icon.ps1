param(
  [Parameter(Mandatory=$true)][string]$Match,
  [int]$TimeoutSeconds = 45
)

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  public static List<string> Find(string match, out List<IntPtr> handles) {
    var found = new List<string>();
    var local = new List<IntPtr>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, sb.Capacity);
      var title = sb.ToString();
      if (title.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) {
        local.Add(h);
        uint pid; GetWindowThreadProcessId(h, out pid);
        found.Add("hwnd=0x" + h.ToInt64().ToString("x") + " pid=" + pid + " visible=" + IsWindowVisible(h) + " title=" + title);
      }
      return true;
    }, IntPtr.Zero);
    handles = local;
    return found;
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop

$WM_GETICON = 0x007F
$ICON_SMALL = 0
$ICON_BIG = 1
$ICON_SMALL2 = 2

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$handles = New-Object 'System.Collections.Generic.List[IntPtr]'
$rows = @()
while ((Get-Date) -lt $deadline) {
  $rows = [WinProbe]::Find($Match, [ref]$handles)
  if ($rows.Count -gt 0) { break }
  Start-Sleep -Milliseconds 400
}
if ($rows.Count -eq 0) { Write-Output "no window matching '$Match' within $TimeoutSeconds s"; exit 2 }

foreach ($r in $rows) { Write-Output $r }
for ($i = 0; $i -lt $handles.Count; $i++) {
  $h = $handles[$i]
  $small = [WinProbe]::SendMessageW($h, $WM_GETICON, [IntPtr]$ICON_SMALL, [IntPtr]::Zero)
  $big = [WinProbe]::SendMessageW($h, $WM_GETICON, [IntPtr]$ICON_BIG, [IntPtr]::Zero)
  $small2 = [WinProbe]::SendMessageW($h, $WM_GETICON, [IntPtr]$ICON_SMALL2, [IntPtr]::Zero)
  Write-Output ("hwnd=0x" + $h.ToInt64().ToString("x") + " WM_GETICON small=0x" + $small.ToInt64().ToString("x") + " big=0x" + $big.ToInt64().ToString("x") + " small2=0x" + $small2.ToInt64().ToString("x"))
}
