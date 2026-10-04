@echo off
REM MotelMitra - stop the app (double-click this file)
cd /d "%~dp0"
if not exist logs mkdir logs
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "D=%%i"
taskkill /FI "WINDOWTITLE eq MotelMitra Backend*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq MotelMitra Frontend*" /T /F >nul 2>&1
REM Fallback: anything still holding the two ports
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr /C:":8000 " /C:":5173 "') do taskkill /PID %%p /T /F >nul 2>&1
echo [%date% %time:~0,8%] MotelMitra stopped.
>> "logs\start_app_%D%.txt" echo [%date% %time:~0,8%] MotelMitra stopped by stop_app.bat
timeout /t 3 >nul
