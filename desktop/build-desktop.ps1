# Build the CertVault desktop shell with the .NET Framework compiler (no SDK needed).
#
# Prerequisites:
#   1. Windows with .NET Framework 4.x (csc.exe ships with it) and WebView2 Runtime installed.
#   2. WebView2 SDK DLLs placed in desktop/vendor/webview2/ :
#        Microsoft.Web.WebView2.Core.dll
#        Microsoft.Web.WebView2.WinForms.dll
#        WebView2Loader.dll
#      (from the Microsoft.Web.WebView2 NuGet package)
#
# Output: desktop/bin/CertVault-桌面版/ and desktop/bin/CertVault-数据/ ready to zip.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$here = $PSScriptRoot
$bin = Join-Path $here 'bin'
$ref = Join-Path $here 'vendor\webview2'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "csc.exe not found: $csc" }
if (-not (Test-Path (Join-Path $ref 'Microsoft.Web.WebView2.Core.dll'))) {
  throw "WebView2 SDK not found in $ref (see the header of this script)"
}

$appOut = Join-Path $bin 'CertVault-桌面版'
$dataOut = Join-Path $bin 'CertVault-数据'
Remove-Item $bin -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $appOut, (Join-Path $dataOut 'backup'), (Join-Path $dataOut 'data'), (Join-Path $dataOut 'images') | Out-Null

& $csc /nologo /target:winexe /platform:anycpu /out:"$appOut\CertVault.exe" /win32icon:"$here\app.ico" /win32manifest:"$here\app.manifest" /r:"$ref\Microsoft.Web.WebView2.Core.dll" /r:"$ref\Microsoft.Web.WebView2.WinForms.dll" /r:System.Windows.Forms.dll /r:System.Drawing.dll "$here\CertVault.cs" "$here\HostBridge.cs"
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Copy-Item (Join-Path $ref '*.dll') $appOut -Force
Copy-Item (Join-Path $here 'app.config') (Join-Path $appOut 'CertVault.exe.config') -Force
Copy-Item (Join-Path $here '使用说明.txt') $appOut -Force
Copy-Item (Join-Path $dataOut '放这里的是全部数据（可整文件夹备份）.txt') $dataOut -Force

# frontend (shared with the server build)
New-Item -ItemType Directory -Path (Join-Path $appOut 'app\vendor') -Force | Out-Null
Copy-Item (Join-Path $root 'app\index.html') (Join-Path $appOut 'app') -Force
foreach ($f in 'app.js','core.js','store.js','excel.js','bridge.js','style.css') {
  Copy-Item (Join-Path $root "app\$f") (Join-Path $appOut 'app') -Force
}
Copy-Item (Join-Path $root 'app\vendor\xlsx.full.min.js') (Join-Path $appOut 'app\vendor') -Force
Copy-Item (Join-Path $root 'app\vendor\exceljs.min.js') (Join-Path $appOut 'app\vendor') -Force
Copy-Item (Join-Path $root 'app\vendor\echarts.min.js') (Join-Path $appOut 'app\vendor') -Force
Copy-Item (Join-Path $root 'app\vendor\china-geo.js') (Join-Path $appOut 'app\vendor') -Force
Copy-Item (Join-Path $root 'app\vendor\china-provinces.json') (Join-Path $appOut 'app\vendor') -Force

Write-Host "built: $appOut"
Write-Host "data : $dataOut"