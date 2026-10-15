param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$OutFile,
  [int]$X = 0, [int]$Y = 0, [int]$W = 100, [int]$H = 40, [int]$Scale = 6
)

Add-Type -AssemblyName System.Drawing

$srcImage = [System.Drawing.Image]::FromFile($In)
$crop = New-Object System.Drawing.Rectangle($X, $Y, $W, $H)
$outW = $W * $Scale
$outH = $H * $Scale
$dst = New-Object System.Drawing.Bitmap($outW, $outH)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$dest = New-Object System.Drawing.Rectangle(0, 0, $outW, $outH)
$g.DrawImage($srcImage, $dest, $crop, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$dst.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose()
$srcImage.Dispose()
Write-Output ("saved " + $OutFile + " from " + $X + "," + $Y + " " + $W + "x" + $H + " scale=" + $Scale)
