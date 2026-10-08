@echo off
chcp 65001 >nul
title Xmind Local Patch
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  echo [i] 使用系统 Node.js ...
  node patch.js %*
  goto :done
)

echo [i] 未检测到 Node.js,尝试使用 Xmind 自带运行时 ...
set "XM="
if exist "%~dp0Xmind\Xmind.exe" set "XM=%~dp0Xmind\Xmind.exe"
if exist "%LOCALAPPDATA%\Programs\Xmind\Xmind.exe" set "XM=%LOCALAPPDATA%\Programs\Xmind\Xmind.exe"
if exist "C:\Program Files\Xmind\Xmind.exe" set "XM=C:\Program Files\Xmind\Xmind.exe"
if "%XM%"=="" (
  echo [X] 未找到 Node.js 也未找到 Xmind。请安装 Node.js 后重试。
  goto :done
)
set ELECTRON_RUN_AS_NODE=1
"%XM%" patch.js %*

:done
echo.
pause
