@echo off
rem Zcode-Status-Daily-Use 一键安装
rem
rem 必须先完全退出 ZCode（含托盘图标），否则 app.asar 被占用无法写入。
rem 本文件保存为 GBK + CRLF —— 中文 Windows 控制台按 GBK 解码 batch 文件，
rem 存成 UTF-8 会出现乱码甚至命令被截断。

chcp 936 >nul
setlocal

cd /d "%~dp0"

echo.
echo   Zcode-Status-Daily-Use 安装程序
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

python install.py %*
if errorlevel 1 (
    echo.
    echo   安装失败，请查看上面的错误信息。
    echo.
    pause
    exit /b 1
)

echo.
echo   请重新启动 ZCode，然后打开 设置 - 用量。
echo.
pause
endlocal
