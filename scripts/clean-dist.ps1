$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
if ((Split-Path -Parent $target) -ne $projectRoot -or (Split-Path -Leaf $target) -ne 'dist') {
    throw "拒绝清理非预期目录: $target"
}
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "拒绝清理链接目录: $target"
    }
    $links = @(Get-ChildItem -LiteralPath $target -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop)
    if ($links.Count -gt 0) { throw "拒绝清理包含链接的编译目录: $target" }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
}
