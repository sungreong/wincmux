@echo off
setlocal

cd /d "%~dp0"

if /i "%~1"=="/?" goto :help
if /i "%~1"=="-h" goto :help
if /i "%~1"=="--help" goto :help

where node >nul 2>nul
if errorlevel 1 (
  echo [WinCMux] Node.js 20+ is required. Install Node.js, then run dev.bat again.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [WinCMux] npm is required. Install Node.js with npm, then run dev.bat again.
  exit /b 1
)

if not exist "node_modules\.bin\tauri.cmd" (
  echo [WinCMux] Installing dependencies...
  call npm ci
  if errorlevel 1 exit /b %errorlevel%
)

echo [WinCMux] Starting development app...
call npm run dev
exit /b %errorlevel%

:help
echo Usage: dev.bat
echo.
echo Starts WinCMux with Tauri and the Rust core.
echo Requires Node.js 20+, Rust MSVC, Visual Studio C++ Build Tools, and WebView2.
exit /b 0
