$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
$packageDirectoryNames = @('win-unpacked', 'win-unpacked.tmp')
foreach ($directoryName in $packageDirectoryNames) {
    $target = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot $directoryName))
    if ((Split-Path -Parent $target) -ne $releaseRoot -or (Split-Path -Leaf $target) -ne $directoryName) {
        throw "拒绝清理非预期目录: $target"
    }
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
            throw "拒绝清理非普通目录: $target"
        }
        $links = @(Get-ChildItem -LiteralPath $target -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop)
        if ($links.Count -gt 0) {
            throw "拒绝清理包含链接的目录: $target"
        }
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
}

$staleUpdateMetadata = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot 'latest.yml'))
if ((Split-Path -Parent $staleUpdateMetadata) -ne $releaseRoot -or (Split-Path -Leaf $staleUpdateMetadata) -ne 'latest.yml') {
    throw "拒绝清理非预期文件: $staleUpdateMetadata"
}
if (Test-Path -LiteralPath $staleUpdateMetadata) {
    $metadataItem = Get-Item -LiteralPath $staleUpdateMetadata -Force
    if ($metadataItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "拒绝清理链接文件: $staleUpdateMetadata"
    }
    Remove-Item -LiteralPath $staleUpdateMetadata -Force -ErrorAction Stop
}
