@echo off
REM Opens the FinFolio build window, then closes this console.
cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
  echo Windows PowerShell was not found. Use build.bat instead.
  pause
  exit /b 1
)

start "FinFolio build" powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0scripts\build-gui.ps1"
exit /b 0
