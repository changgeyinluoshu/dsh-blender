@echo off
rem Double-click to publish this repository to GitHub.
setlocal
set "SCRIPT=%~dp0scripts\publish-to-github.ps1"
where pwsh >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
echo.
pause
exit /b %ERRORLEVEL%
