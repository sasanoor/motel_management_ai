@echo off
REM ==================================================================
REM  MotelMitra - start the whole app (double-click this file)
REM
REM  Runs on BOTH:
REM    http://localhost:5173        on this PC
REM    http://<this PC's IP>:5173   on phones / tablets / PCs on the same WiFi
REM  The IPv4 address is detected automatically every time you start.
REM
REM  Logs (one file per day) in the "logs" folder:
REM    logs\start_app_YYYY-MM-DD.txt   this launcher
REM    logs\backend_YYYY-MM-DD.txt     Django (API, errors, requests)
REM    logs\frontend_YYYY-MM-DD.txt    React / Vite
REM  Current links are saved in app_links.txt
REM ==================================================================
setlocal EnableExtensions
title MotelMitra Launcher
cd /d "%~dp0"
set "ROOT=%~dp0"

REM  1 = localhost + WiFi (default), 0 = this PC only
set "LAN=1"
set "FRONT_PORT=5173"
set "BACK_PORT=8000"

if not exist "%ROOT%logs" mkdir "%ROOT%logs"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set "D=%%i"
set "LOG=%ROOT%logs\start_app_%D%.txt"

call :log "================ Starting MotelMitra ================"

REM ---------- detect this PC's IPv4 address (adapter with internet gateway first)
set "IP="
if not "%LAN%"=="1" goto :ip_done
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$c = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1; if ($c) { $c.IPv4Address[0].IPAddress } else { (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' -and $_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|WSL|Loopback' } | Select-Object -First 1).IPAddress }"`) do set "IP=%%i"
:ip_done
if "%LAN%"=="1" if not defined IP (
  call :log "WARNING: No WiFi/network IPv4 address found. Starting on this PC only."
  set "LAN=0"
)
if "%LAN%"=="1" ( call :log "This PC's IPv4 address: %IP%" )

REM ---------- bind addresses and allowed hosts (overrides backend\.env for this run)
if "%LAN%"=="1" (
  set "BIND=0.0.0.0"
  set "ALLOWED_HOSTS=127.0.0.1,localhost,%IP%"
  set "CORS_ALLOWED_ORIGINS=http://localhost:%FRONT_PORT%,http://127.0.0.1:%FRONT_PORT%,http://%IP%:%FRONT_PORT%"
) else (
  set "BIND=127.0.0.1"
  set "ALLOWED_HOSTS=127.0.0.1,localhost"
  set "CORS_ALLOWED_ORIGINS=http://localhost:%FRONT_PORT%,http://127.0.0.1:%FRONT_PORT%"
)

REM ---------- already running?
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:%FRONT_PORT% | Out-Null; exit 0}catch{exit 1}"
if not errorlevel 1 (
  call :log "MotelMitra is already running."
  call :links
  start "" http://localhost:%FRONT_PORT%
  goto :done
)

REM ---------- find Python
set "PY="
python --version >nul 2>&1 && set "PY=python"
if not defined PY ( py --version >nul 2>&1 && set "PY=py" )
if not defined PY (
  call :log "ERROR: Python not found. Install it from python.org and tick 'Add to PATH'."
  goto :fail
)
for /f "delims=" %%v in ('%PY% --version 2^>^&1') do call :log "Python: %%v"

REM ---------- find Node
where npm >nul 2>&1
if errorlevel 1 (
  call :log "ERROR: Node.js not found. Install the LTS version from nodejs.org."
  goto :fail
)
for /f "delims=" %%v in ('node --version') do call :log "Node: %%v"

REM ---------- backend settings file
if not exist "%ROOT%backend\.env" (
  copy "%ROOT%backend\.env.example" "%ROOT%backend\.env" >nul
  call :log "WARNING: backend\.env was missing, created from .env.example. Set your DB password in it."
)

REM ---------- Python packages (first run only)
%PY% -c "import django, rest_framework, corsheaders, rest_framework_simplejwt, dotenv" >nul 2>&1
if errorlevel 1 (
  call :log "Installing Python packages (first run)..."
  %PY% -m pip install -r "%ROOT%backend\requirements.txt" >> "%LOG%" 2>&1
  if errorlevel 1 ( call :log "ERROR: pip install failed. See this log." & goto :fail )
)

REM ---------- frontend packages (first run only)
if exist "%ROOT%frontend\node_modules" goto :npm_ok
call :log "Installing frontend packages (first run, takes a minute)..."
pushd "%ROOT%frontend"
call npm install >> "%LOG%" 2>&1
set "NPMERR=%errorlevel%"
popd
if not "%NPMERR%"=="0" ( call :log "ERROR: npm install failed. See this log." & goto :fail )
:npm_ok

REM ---------- database updates (safe to run every time)
call :log "Applying database updates..."
pushd "%ROOT%backend"
%PY% manage.py migrate --noinput >> "%LOG%" 2>&1
set "MIGERR=%errorlevel%"
popd
if not "%MIGERR%"=="0" (
  call :log "ERROR: Database update failed. Check MySQL is running and backend\.env is correct."
  goto :fail
)

REM ---------- Windows Firewall: allow the two ports on Private networks (needs admin once)
if "%LAN%"=="1" call :firewall

REM ---------- delete logs older than 30 days
forfiles /p "%ROOT%logs" /m *.txt /d -30 /c "cmd /c del @path" >nul 2>&1

REM ---------- start servers in their own minimised windows
call :log "Starting backend on %BIND%:%BACK_PORT%, log file: logs\backend_%D%.txt"
start "MotelMitra Backend" /min cmd /c ""%ROOT%scripts\run_backend.bat" %PY% %D% %BIND% %BACK_PORT%"
call :log "Starting frontend on %BIND%:%FRONT_PORT%, log file: logs\frontend_%D%.txt"
start "MotelMitra Frontend" /min cmd /c ""%ROOT%scripts\run_frontend.bat" %BIND% %D% %FRONT_PORT%"

REM ---------- wait until both answer on localhost
call :log "Waiting for the app to come up..."
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:%BACK_PORT%/api/auth/me/ | Out-Null; exit 0}catch{if($_.Exception.Response){exit 0}; Start-Sleep 1}}; exit 1"
if errorlevel 1 ( call :log "ERROR: Backend did not start. Open logs\backend_%D%.txt" & goto :fail )
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://localhost:%FRONT_PORT% | Out-Null; exit 0}catch{Start-Sleep 1}}; exit 1"
if errorlevel 1 ( call :log "ERROR: Frontend did not start. Open logs\frontend_%D%.txt" & goto :fail )

REM ---------- confirm it also answers on the WiFi address
if "%LAN%"=="1" (
  powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -TimeoutSec 4 http://%IP%:%FRONT_PORT% | Out-Null; exit 0}catch{exit 1}"
  if errorlevel 1 ( call :log "WARNING: App is not answering on %IP%. Other devices may not connect." ) else ( call :log "WiFi address check: OK" )
)

call :log "MotelMitra is running."
call :links
start "" http://localhost:%FRONT_PORT%

:done
echo.
echo  ------------------------------------------------------------
echo   This PC:         http://localhost:%FRONT_PORT%
if "%LAN%"=="1" echo   Other devices:   http://%IP%:%FRONT_PORT%   (same WiFi)
echo   Links saved in:  app_links.txt
echo   To stop:         double-click stop_app.bat
echo  ------------------------------------------------------------
echo  This window closes in 30 seconds.
timeout /t 30 >nul
endlocal
exit /b 0

:fail
echo.
echo  Something went wrong. Details are in: logs\start_app_%D%.txt
pause
endlocal
exit /b 1

REM ================================================================ helpers
:log
echo [%date% %time:~0,8%] %~1
>> "%LOG%" echo [%date% %time:~0,8%] %~1
exit /b 0

:links
call :log "This PC:       http://localhost:%FRONT_PORT%"
if "%LAN%"=="1" call :log "Other devices: http://%IP%:%FRONT_PORT%"
> "%ROOT%app_links.txt" echo MotelMitra links (updated %date% %time:~0,8%)
>> "%ROOT%app_links.txt" echo.
>> "%ROOT%app_links.txt" echo This PC:          http://localhost:%FRONT_PORT%
if "%LAN%"=="1" >> "%ROOT%app_links.txt" echo WiFi devices:     http://%IP%:%FRONT_PORT%
if "%LAN%"=="1" >> "%ROOT%app_links.txt" echo Django admin:     http://%IP%:%BACK_PORT%/admin/
>> "%ROOT%app_links.txt" echo.
>> "%ROOT%app_links.txt" echo The WiFi address can change if the router restarts. Start the app again to refresh it.
exit /b 0

:firewall
netsh advfirewall firewall show rule name="MotelMitra %FRONT_PORT%" >nul 2>&1
if not errorlevel 1 exit /b 0
netsh advfirewall firewall add rule name="MotelMitra %FRONT_PORT%" dir=in action=allow protocol=TCP localport=%FRONT_PORT% profile=private,domain >nul 2>&1
if errorlevel 1 (
  call :log "NOTE: Could not add firewall rules. Right-click start_app.bat, Run as administrator, once."
  exit /b 0
)
netsh advfirewall firewall add rule name="MotelMitra %BACK_PORT%" dir=in action=allow protocol=TCP localport=%BACK_PORT% profile=private,domain >nul 2>&1
call :log "Firewall rules added for ports %FRONT_PORT% and %BACK_PORT% (Private networks)."
exit /b 0
