@echo off
REM Called by start_app.bat. Args: %1 bind address, %2 date (log name), %3 port
cd /d "%~dp0..\frontend"
set "NO_COLOR=1"
set "FORCE_COLOR=0"
set "LOGF=%~dp0..\logs\frontend_%2.txt"
>> "%LOGF%" echo.
>> "%LOGF%" echo ===== Frontend started %date% %time:~0,8% on %1:%3 =====
call npm run dev -- --host %1 --port %3 --strictPort >> "%LOGF%" 2>&1
>> "%LOGF%" echo ===== Frontend stopped %date% %time:~0,8% =====
