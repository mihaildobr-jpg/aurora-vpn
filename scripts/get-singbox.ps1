# Скачивает ядро sing-box для Windows и кладёт его туда, где его ждёт Tauri (externalBin).
param([string]$Version = "1.14.4")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$dest = Join-Path $bin "sing-box-x86_64-pc-windows-msvc.exe"
$name = "sing-box-$Version-windows-amd64"
$zip = Join-Path $env:TEMP "$name.zip"
$url = "https://github.com/SagerNet/sing-box/releases/download/v$Version/$name.zip"

Write-Host "Скачиваю $url"
Invoke-WebRequest -Uri $url -OutFile $zip
$tmp = Join-Path $env:TEMP $name
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $env:TEMP -Force
Copy-Item (Join-Path $tmp "sing-box.exe") $dest -Force
Copy-Item (Join-Path $tmp "libcronet.dll") (Join-Path $bin "libcronet.dll") -Force
Write-Host "Готово: $dest"
