param(
  [string]$WindowMatch = "omp-bot",
  [int]$TimeoutSeconds = 15
)

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WindowAppProps {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential, Pack=4)]
  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out uint count);
    int GetAt(uint index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    int Commit();
  }

  [DllImport("shell32.dll")]
  public static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid riid, out IPropertyStore store);

  [DllImport("ole32.dll")]
  public static extern int PropVariantClear(ref PROPVARIANT variant);

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder name, ref uint size);

  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);

  public static string ProcessImage(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "(open failed)";
    try {
      var sb = new StringBuilder(1024);
      uint size = 1024;
      if (!QueryFullProcessImageNameW(h, 0, sb, ref size)) return "(query failed)";
      return sb.ToString();
    } finally { CloseHandle(h); }
  }

  static readonly Guid IID_IPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
  static readonly Guid PKEY_FMTID = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

  public static string WindowProperty(IntPtr hwnd, uint pid) {
    IPropertyStore store;
    var iid = IID_IPropertyStore;
    int hr = SHGetPropertyStoreForWindow(hwnd, ref iid, out store);
    if (hr != 0) return "(SHGetPropertyStoreForWindow hr=0x" + hr.ToString("x") + ")";
    var key = new PROPERTYKEY { fmtid = PKEY_FMTID, pid = pid };
    PROPVARIANT value;
    hr = store.GetValue(ref key, out value);
    if (hr != 0) return "(absent hr=0x" + hr.ToString("x") + ")";
    string result;
    if (value.vt == 31 && value.pointerValue != IntPtr.Zero) result = Marshal.PtrToStringUni(value.pointerValue);
    else if (value.vt == 0) result = "(empty)";
    else result = "(vt=" + value.vt + ")";
    PropVariantClear(ref value);
    Marshal.ReleaseComObject(store);
    return result;
  }

  public static List<IntPtr> Find(string match) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$handles = New-Object 'System.Collections.Generic.List[IntPtr]'
while ((Get-Date) -lt $deadline) {
  $handles = [WindowAppProps]::Find($WindowMatch)
  if ($handles.Count -gt 0) { break }
  Start-Sleep -Milliseconds 400
}
if ($handles.Count -eq 0) { Write-Output ("no window matching '" + $WindowMatch + "'"); exit 2 }

foreach ($h in $handles) {
  $sb = New-Object System.Text.StringBuilder 512
  [WindowAppProps]::GetWindowTextW($h, $sb, 512) | Out-Null
  $pidValue = 0
  [WindowAppProps]::GetWindowThreadProcessId($h, [ref]$pidValue) | Out-Null
  Write-Output ("window hwnd=0x" + $h.ToInt64().ToString("x") + " pid=" + $pidValue + " visible=" + [WindowAppProps]::IsWindowVisible($h) + " title=" + $sb.ToString())
  Write-Output ("  processImage=" + [WindowAppProps]::ProcessImage($pidValue))
  Write-Output ("  AppUserModelID      = " + [WindowAppProps]::WindowProperty($h, 5))
  Write-Output ("  RelaunchCommand     = " + [WindowAppProps]::WindowProperty($h, 2))
  Write-Output ("  RelaunchIconResource= " + [WindowAppProps]::WindowProperty($h, 3))
  Write-Output ("  RelaunchDisplayName = " + [WindowAppProps]::WindowProperty($h, 4))
}
