@echo off
chcp 65001 >nul
setlocal EnableExtensions
title CertVault

rem ============================================================
rem  CertVault v1 便携版启动器
rem  作用：用 Edge（找不到则用 Chrome）以“应用窗口”(--app) 打开 app\index.html
rem  要求：本文件必须和 app\ 文件夹放在同一目录；整个文件夹可一起拷走
rem  说明：路径含中文、空格均可正常打开；找不到浏览器时用系统默认浏览器
rem ============================================================

rem ---- 1. 检查程序文件是否存在 ----
set "HTML=%~dp0app\index.html"
if not exist "%HTML%" (
    echo [错误] 找不到程序文件：
    echo        %HTML%
    echo.
    echo        请把“启动 CertVault.bat”和 app 文件夹放在同一个目录里，
    echo        再双击本文件。
    echo.
    pause
    exit /b 1
)

rem ---- 2. 把 Windows 路径转成 file:/// 地址 ----
rem       %%~dp0 末尾自带反斜杠；把反斜杠全部换成正斜杠，中文和空格保持原样
set "HTML_FWD=%HTML:\=/%"
set "URL=file:///%HTML_FWD%"

rem ---- 3. 依次查找 Edge / Chrome 的安装位置 ----
set "BROWSER="
call :find_edge
if not defined BROWSER call :find_chrome

rem ---- 4. 找到浏览器：用应用窗口打开（无地址栏，像软件） ----
if defined BROWSER (
    echo 正在用应用窗口打开 CertVault ...
    start "" "%BROWSER%" "--app=%URL%" --window-size=1500,940
    endlocal
    exit /b 0
)

rem ---- 5. 找不到浏览器：中文提示 + 用系统默认浏览器打开 ----
echo [提示] 没有找到 Microsoft Edge 或 Google Chrome。
echo        现在改用系统默认浏览器打开（窗口上方会显示地址栏，功能相同）。
echo        建议安装 Microsoft Edge 后，再双击本文件即可获得更接近软件的窗口。
echo.
start "" "%URL%"
endlocal
exit /b 0

rem ============ 内部函数：按常见安装路径查找浏览器 ============

:find_edge
set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramW6432%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramW6432%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
goto :eof

:find_chrome
set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramW6432%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramW6432%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
goto :eof
