# 用 System.Drawing 生成应用图标(256x256 PNG)与托盘图标(16x16 PNG)
# R6: 直接输出 PNG,electron-builder 会自动把 assets/icon.png 转换为 ICO
# 运行: powershell -ExecutionPolicy Bypass -File scripts/gen-icon.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
if (-not (Test-Path $assets)) { New-Item -ItemType Directory $assets | Out-Null }

function New-IconBmp([int]$size) {
    # 画一个圆角深蓝底 + 白色 "D" 字母
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    # 用 RectangleF:DrawString 的 (RectangleF, StringFormat) 重载;Rectangle 会被误绑到 PointF 重载导致转换失败
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 9, 105, 218))
    $g.FillEllipse($brush, $rect)
    $font = New-Object System.Drawing.Font('Segoe UI', [float]($size * 0.62), [System.Drawing.FontStyle]::Bold)
    $white = [System.Drawing.Brushes]::White
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
    $g.DrawString('D', $font, $white, $rect, $sf)
    $g.Dispose(); $brush.Dispose(); $font.Dispose(); $sf.Dispose()
    return $bmp
}

$appPng = Join-Path $assets 'icon.png'
$trayPng = Join-Path $assets 'tray.png'

$bmp256 = New-IconBmp 256
$bmp256.Save($appPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp256.Dispose()

$bmp16 = New-IconBmp 16
$bmp16.Save($trayPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp16.Dispose()

Write-Host "已生成: $appPng 与 $trayPng"
