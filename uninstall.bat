@echo off
rem Zcode-Status-Daily-Use 一键卸载
rem
rem 必须先完全退出 ZCode（含托盘图标）。
rem 本文件保存为 GBK + CRLF（中文控制台按 GBK 解码 batch）。

chcp 936 >nul
setlocal

cd /d "%~dp0"

echo.
echo   Zcode-Status-Daily-Use 卸载程序
echo   ----------------------------------------
echo.

tasklist /FI "IMAGENAME eq ZCode.exe" /NH | find /I "ZCode.exe" >nul
if not errorlevel 1 (
    echo   [错误] 检测到 ZCode 正在运行。
    echo   请完全退出 ZCode（包括系统托盘图标）后重新运行本程序。
    echo.
    pause
    exit /b 1
)

python install.py --uninstall %*
if errorlevel 1 (
    echo.
    echo   卸载失败，请查看上面的错误信息。
    echo.
    pause
    exit /b 1
)

echo.
pause
endlocal
