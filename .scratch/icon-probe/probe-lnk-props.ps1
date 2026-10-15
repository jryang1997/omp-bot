param([Parameter(Mandatory=$true)][string]$Lnk)

$src = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LnkProps {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  public class ShellLinkCoClass { }

  [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    int GetCount(out uint count);
    int GetAt(uint index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    int Commit();
  }

  [StructLayout(LayoutKind.Sequential, Pack=4)]
  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [DllImport("ole32.dll")]
  public static extern int PropVariantClear(ref PROPVARIANT variant);

  public static string Read(string lnkPath, uint pid) {
    object link = new ShellLinkCoClass();
    IPropertyStore store = (IPropertyStore)link;
    ((IPersistFile)link).Load(lnkPath, 0);
    var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = pid };
    PROPVARIANT value;
    int hr = store.GetValue(ref key, out value);
    if (hr != 0) return "(hr=0x" + hr.ToString("x") + ")";
    string result;
    if (value.vt == 31 && value.pointerValue != IntPtr.Zero) result = Marshal.PtrToStringUni(value.pointerValue);
    else if (value.vt == 0) result = "(empty)";
    else result = "(vt=" + value.vt + ")";
    PropVariantClear(ref value);
    Marshal.ReleaseComObject(store);
    Marshal.ReleaseComObject(link);
    return result;
  }
}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPersistFile {
  void GetClassID(out Guid pClassID);
  void IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, bool fRemember);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
  void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop

$names = @{ 2 = "RelaunchCommand"; 3 = "RelaunchIconResource"; 4 = "RelaunchDisplayNameResource"; 5 = "AppUserModelID" }
Write-Output ("lnk=" + $Lnk)
foreach ($propId in @(5, 2, 3, 4)) {
  Write-Output ("  " + $names[$propId] + " = " + [LnkProps]::Read($Lnk, $pid))
}
