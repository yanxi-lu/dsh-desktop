# Generate the app icon set from the high-res source PNG in the project root
# (default: the single *.png at project root, e.g. the 2048x2048 whale-girl icon).
# Outputs:
#   assets/icon.png  1024x1024 app PNG (kept inside asar as a fallback)
#   assets/icon.ico  multi-size PNG-compressed ICO (16..512, incl. 256/512),
#                    embedded by electron-builder into the exe, NSIS installer
#                    and desktop/start-menu shortcuts
#   assets/tray.png  32x32 tray icon (crisp on high-DPI; Windows scales to 16px)
# Usage: npm run icon
# NOTE: keep this file ASCII-only; Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [string]$Source = ''
)
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if (-not $Source) {
    $pngs = @(Get-ChildItem -Path $root -Filter '*.png' -File)
    if ($pngs.Count -eq 1) { $Source = $pngs[0].FullName }
    elseif ($pngs.Count -eq 0) { throw "No PNG source found in project root: $root" }
    else { throw "Multiple PNGs in project root, pass -Source explicitly: $($pngs.FullName -join '; ')" }
}
if (-not (Test-Path $Source)) { throw "Source icon not found: $Source" }

$assets = Join-Path $root 'assets'
if (-not (Test-Path $assets)) { New-Item -ItemType Directory $assets | Out-Null }

$src = [System.Drawing.Bitmap]::FromFile($Source)

function New-Scaled([System.Drawing.Image]$from, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $g.DrawImage($from, $rect, 0, 0, $from.Width, $from.Height, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    return $bmp
}

# Intermediate 256 master: scale big->256 first, then 256->small, to avoid aliasing
$master256 = New-Scaled $src 256
if ($null -eq $master256) { throw 'master256 scaling failed' }

# 1) App PNG (1024x1024)
$pngPath = Join-Path $assets 'icon.png'
$bmp1024 = New-Scaled $src 1024
$bmp1024.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp1024.Dispose()
Write-Host "Generated: $pngPath (1024x1024)"

# 2) Tray PNG (32x32, from the 256 master)
$trayPath = Join-Path $assets 'tray.png'
$bmp32 = New-Scaled $master256 32
$bmp32.Save($trayPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp32.Dispose()
Write-Host "Generated: $trayPath (32x32)"

# 3) Multi-size ICO (PNG-compressed entries; supported on Win7+)
$sizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256, 512)
# ArrayList keeps each PNG byte array as ONE element: method-call arguments are
# not pipeline-enumerated, and explicit [byte[]] casts prevent PS from unrolling
$blobs = New-Object System.Collections.ArrayList
foreach ($s in $sizes) {
    if ($s -le 256) { $bmp = New-Scaled $master256 $s }
    else { $bmp = New-Scaled $src $s }
    $pngMs = New-Object System.IO.MemoryStream
    $bmp.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
    [void]$blobs.Add([byte[]]$pngMs.ToArray())
    $pngMs.Dispose()
    $bmp.Dispose()
}
$master256.Dispose()
$src.Dispose()

$icoPath = Join-Path $assets 'icon.ico'
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
# ICO header: reserved=0, type=1 (icon), entry count
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$blobs.Count)
$offset = 6 + 16 * $blobs.Count
for ($i = 0; $i -lt $blobs.Count; $i++) {
    $bytes = [byte[]]$blobs[$i]; $s = $sizes[$i]
    $dim = if ($s -ge 256) { 0 } else { $s }   # 256+ is recorded as 0
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)              # width / height
    $bw.Write([byte]0); $bw.Write([byte]0)                    # palette / reserved
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)               # planes / bpp
    $bw.Write([UInt32]$bytes.Length); $bw.Write([UInt32]$offset)  # size / offset
    $offset += $bytes.Length
}
for ($i = 0; $i -lt $blobs.Count; $i++) {
    $bw.Write([byte[]]$blobs[$i])
}
$bw.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()
Write-Host "Generated: $icoPath (sizes: $($sizes -join ', '))"
