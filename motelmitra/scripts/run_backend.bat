@echo off
REM Called by start_app.bat. Args: %1 python, %2 date (log name), %3 bind address, %4 port
REM ALLOWED_HOSTS / CORS_ALLOWED_ORIGINS come from start_app.bat (they include this PC's WiFi IP)
cd /d "%~dp0..\backend"
set "PYTHONUNBUFFERED=1"
set "LOGF=%~dp0..\logs\backend_%2.txt"
>> "%LOGF%" echo.
>> "%LOGF%" echo ===== Backend started %date% %time:~0,8% on %3:%4  (allowed hosts: %ALLOWED_HOSTS%) =====
%1 manage.py runserver %3:%4 --noreload >> "%LOGF%" 2>&1
>> "%LOGF%" echo ===== Backend stopped %date% %time:~0,8% =====
