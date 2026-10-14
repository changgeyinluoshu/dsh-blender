@echo off
rem dsh-blender-studio installer (Windows wrapper).
rem Prefers PowerShell 7 (pwsh), falls back to Windows PowerShell.
setlocal
set "SCRIPT=%~dp0install.ps1"
where pwsh >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
exit /b %ERRORLEVEL%
