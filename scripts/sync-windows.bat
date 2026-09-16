@echo off
REM Daily data refresh for Windows Task Scheduler.
REM Imports new results, retrains, rescores settled predictions and predicts
REM fixtures that have entered the forecast window. Output is appended to
REM logs\data-sync.log so a failed overnight run can be diagnosed after the fact.

setlocal

cd /d "%~dp0.." || exit /b 1

set "LOG_DIR=%CD%\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\data-sync.log"

REM Every redirect below keeps a space before ">>". Without it cmd reads a
REM trailing digit (%TIME% ends in one) as a file-handle number and the line
REM silently goes nowhere.
echo. >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"
echo Sync started %DATE% %TIME% >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"

REM Task Scheduler does not always inherit the interactive shell's PATH.
where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found on PATH. Reinstall Node.js, or set the task to >> "%LOG_FILE%"
  echo        run as your own user account so the profile PATH is loaded. >> "%LOG_FILE%"
  exit /b 9009
)

REM "call" is required: npm is a .cmd shim and would end this script otherwise.
call npm run data:sync >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
  echo Sync finished OK at %DATE% %TIME% >> "%LOG_FILE%"
) else (
  echo Sync FAILED with exit code %EXIT_CODE% at %DATE% %TIME% >> "%LOG_FILE%"
)

exit /b %EXIT_CODE%
