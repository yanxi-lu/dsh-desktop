$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$target = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'dist'))
if ((Split-Path -Parent $target) -ne $projectRoot -or (Split-Path -Leaf $target) -ne 'dist') {
    throw "拒绝清理非预期目录: $target"
}
if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "拒绝清理链接目录: $target"
    }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
}
