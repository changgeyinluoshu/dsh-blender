@echo off
rem dsh-blender-studio uninstaller (Windows wrapper).
setlocal
set "SCRIPT=%~dp0uninstall.ps1"
where pwsh >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
exit /b %ERRORLEVEL%
