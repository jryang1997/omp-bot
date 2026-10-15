param(
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$StripHeight = 48,
  [int]$PadBottom = 0
)

Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Runtime.InteropServices;
public class ScreenInfo {
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
[ScreenInfo]::SetProcessDPIAware() | Out-Null

$width = [ScreenInfo]::GetSystemMetrics(0)
$height = [ScreenInfo]::GetSystemMetrics(1)
Write-Output ("screen=" + $width + "x" + $height)

$bmp = New-Object System.Drawing.Bitmap($width, $StripHeight)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$y = $height - $StripHeight - $PadBottom
$gfx.CopyFromScreen(0, $y, 0, 0, (New-Object System.Drawing.Size($width, $StripHeight)))
$gfx.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("saved " + $Out + " region y=" + $y + " h=" + $StripHeight)
