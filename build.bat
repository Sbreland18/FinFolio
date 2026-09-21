@echo off
setlocal EnableExtensions EnableDelayedExpansion
title FinFolio - Build the Windows installer
cd /d "%~dp0"

echo.
echo  ===============================================
echo    FinFolio - Build the Windows installer
echo  ===============================================
echo.

REM ---------------------------------------------------------------
REM  1. Node.js
REM ---------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node.js was not found.
  echo.
  echo      FinFolio is built with Node.js. Install the LTS version from
  echo      https://nodejs.org  ^(take the default options^), close this
  echo      window, then run build.bat again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo  [OK] Node.js !NODEVER!

for /f "tokens=1 delims=." %%a in ("!NODEVER:v=!") do set NODEMAJOR=%%a
if !NODEMAJOR! LSS 20 (
  echo.
  echo  [X] Node.js 20 or newer is required ^(found !NODEVER!^).
  echo      Install the current LTS from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo  [X] npm was not found. Reinstall Node.js and try again.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------
REM  2. Dependencies
REM ---------------------------------------------------------------
if not exist "node_modules\electron" (
  echo.
  echo  [..] Installing dependencies. The first run downloads Electron
  echo       ^(about 150 MB^) and can take a few minutes.
  echo.
  call npm install
  if errorlevel 1 goto :failed
) else (
  echo  [OK] Dependencies already installed
)

REM ---------------------------------------------------------------
REM  3. Self-check
REM ---------------------------------------------------------------
echo.
echo  [..] Checking the source and running the tests
call npm run verify
if errorlevel 1 (
  echo.
  echo  [X] The checks failed, so nothing was built. Scroll up for details.
  echo.
  pause
  exit /b 1
)

REM ---------------------------------------------------------------
REM  4. Build
REM ---------------------------------------------------------------
echo.
echo  [..] Building the installer. This takes a couple of minutes.
echo.
call npm run dist
if errorlevel 1 goto :failed

REM ---------------------------------------------------------------
REM  5. Done
REM ---------------------------------------------------------------
echo.
echo  ===============================================
echo    Build complete
echo  ===============================================
echo.
echo  Files created in the "dist" folder:
echo.
for %%f in ("dist\*.exe") do echo    %%~nxf   (%%~zf bytes)
echo.
echo  Run the Setup file to install FinFolio, or share it with
echo  another Windows PC. The Portable file runs without installing.
echo.

choice /c YN /n /m "  Open the dist folder now? [Y/N] "
if errorlevel 2 goto :end
start "" "%CD%\dist"

:end
echo.
pause
exit /b 0

:failed
echo.
echo  [X] The build failed. The message above says why.
echo.
echo      Things that usually fix it:
echo        - Close any running copy of FinFolio, then try again
echo        - Delete the "node_modules" folder and re-run build.bat
echo        - Make sure your antivirus is not blocking the "dist" folder
echo.
pause
exit /b 1
