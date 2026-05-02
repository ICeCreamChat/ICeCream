@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title ICeCream Dev Server

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "GATEWAY_PORT=3000"
set "TIMEFOLD_PORT=8081"
set "MANIM_PORT=8001"

echo.
echo   ICeCream Dev Server
echo   Working directory: %CD%
echo.

:: ============================================================
:: Basic environment checks
:: ============================================================
where node >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js not found. Install it from https://nodejs.org/
    pause
    exit /b 1
)

set "PYTHON_CMD="
where python >nul 2>&1 && set "PYTHON_CMD=python"

set "JAVA_OK=0"
where java >nul 2>&1 && set "JAVA_OK=1"

:: ============================================================
:: Project setup
:: ============================================================
if not exist ".env" if exist ".env.example" (
    echo [Setup] Creating .env from .env.example...
    copy ".env.example" ".env" >nul
)

if not exist "uploads" mkdir "uploads" >nul 2>&1
if not exist "logs" mkdir "logs" >nul 2>&1
if not exist "manim-service\static" mkdir "manim-service\static" >nul 2>&1
if not exist "manim-service\temp_gen" mkdir "manim-service\temp_gen" >nul 2>&1

if not exist "node_modules" (
    echo [Setup] Installing npm dependencies...
    call npm install
    if errorlevel 1 (
        echo [X] npm install failed.
        pause
        exit /b 1
    )
)

:: ============================================================
:: Optional Manim service
:: ============================================================
set "MANIM_ENABLED=0"
if defined PYTHON_CMD if exist "manim-service\main.py" (
    set "MANIM_ENABLED=1"

    if not exist "manim-service\.venv\Scripts\python.exe" (
        echo [Setup] Creating Manim Python virtual environment...
        pushd "manim-service"
        %PYTHON_CMD% -m venv .venv
        if errorlevel 1 (
            echo [WARN] Failed to create Manim virtual environment. Manim will be disabled.
            set "MANIM_ENABLED=0"
        )
        popd
    )

    if "!MANIM_ENABLED!"=="1" if exist "manim-service\requirements.txt" if not exist "manim-service\.venv\.icecream-requirements-ok" (
        echo [Setup] Installing Manim Python dependencies...
        pushd "manim-service"
        .venv\Scripts\python.exe -m pip install -r requirements.txt
        if errorlevel 1 (
            echo [WARN] Failed to install Manim dependencies. Manim will be disabled.
            set "MANIM_ENABLED=0"
        ) else (
            type nul > ".venv\.icecream-requirements-ok"
        )
        popd
    )
) else (
    echo [WARN] Python or manim-service\main.py not found. Manim will be disabled.
)

:: ============================================================
:: Optional Timefold solver
:: ============================================================
set "TIMEFOLD_ENABLED=0"
if "%JAVA_OK%"=="1" (
    if exist "solver\mvnw.cmd" (
        set "TIMEFOLD_ENABLED=1"
    ) else (
        echo [WARN] solver\mvnw.cmd not found. Timefold will be disabled.
    )
) else (
    echo [WARN] Java not found. Timefold will be disabled and seating will use local fallback.
)

if "!TIMEFOLD_ENABLED!"=="1" if not exist "solver\target\quarkus-app\quarkus-run.jar" (
    echo [Setup] Building Timefold solver with Maven Wrapper...
    pushd "solver"
    call mvnw.cmd -q package -DskipTests
    if errorlevel 1 (
        echo [WARN] Timefold build failed. Seating will use local fallback.
        set "TIMEFOLD_ENABLED=0"
    )
    popd
)

if /i "%~1"=="--check" (
    echo.
    echo [OK] dev.bat check completed.
    echo      Gateway:  enabled
    if "!TIMEFOLD_ENABLED!"=="1" (
        echo      Timefold: enabled
    ) else (
        echo      Timefold: disabled
    )
    if "!MANIM_ENABLED!"=="1" (
        echo      Manim:    enabled
    ) else (
        echo      Manim:    disabled
    )
    exit /b 0
)

:: ============================================================
:: Cleanup only the ports owned by this dev stack
:: ============================================================
call :free_port %GATEWAY_PORT%
if "!TIMEFOLD_ENABLED!"=="1" call :free_port %TIMEFOLD_PORT%
if "!MANIM_ENABLED!"=="1" call :free_port %MANIM_PORT%
timeout /t 1 /nobreak >nul

:: ============================================================
:: Header
:: ============================================================
cls
echo.
echo   +-----------------------------------------------------------+
echo   :                                                           :
echo   :    ICeCream Dev Server                                    :
echo   :                                                           :
echo   :    Frontend:  http://localhost:%GATEWAY_PORT%                       :
if "!TIMEFOLD_ENABLED!"=="1" (
echo   :    Timefold:  http://localhost:%TIMEFOLD_PORT%                       :
) else (
echo   :    Timefold:  disabled, local seating fallback active      :
)
if "!MANIM_ENABLED!"=="1" (
echo   :    Manim:     http://localhost:%MANIM_PORT%                       :
) else (
echo   :    Manim:     disabled                                  :
)
echo   :                                                           :
echo   :    Press Ctrl+C in this window to stop the gateway.        :
echo   :                                                           :
echo   +-----------------------------------------------------------+
echo.

:: ============================================================
:: Start optional services hidden and write their logs under logs\
:: ============================================================
if "!TIMEFOLD_ENABLED!"=="1" (
    echo [Timefold] Starting on port %TIMEFOLD_PORT%...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'java.exe' -ArgumentList '-Dquarkus.http.port=%TIMEFOLD_PORT%','-jar','target\quarkus-app\quarkus-run.jar' -WorkingDirectory '%SCRIPT_DIR%solver' -WindowStyle Hidden -RedirectStandardOutput '%SCRIPT_DIR%logs\timefold.log' -RedirectStandardError '%SCRIPT_DIR%logs\timefold.err.log'"
    timeout /t 4 /nobreak >nul
    set "TIMEFOLD_SOLVER_URL=http://127.0.0.1:%TIMEFOLD_PORT%"
) else (
    set "TIMEFOLD_SOLVER_URL="
)

if "!MANIM_ENABLED!"=="1" (
    echo [Manim] Starting on port %MANIM_PORT%...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c','set MANIM_SERVICE_HOST=127.0.0.1&& set MANIM_SERVICE_PORT=%MANIM_PORT%&& set MANIM_AUTO_FREE_PORT=false&& .venv\Scripts\python.exe main.py' -WorkingDirectory '%SCRIPT_DIR%manim-service' -WindowStyle Hidden -RedirectStandardOutput '%SCRIPT_DIR%logs\manim.log' -RedirectStandardError '%SCRIPT_DIR%logs\manim.err.log'"
    timeout /t 2 /nobreak >nul
    set "MANIM_SERVICE_URL=http://127.0.0.1:%MANIM_PORT%"
)

:: ============================================================
:: Start gateway in this window
:: ============================================================
echo [Gateway] Starting on port %GATEWAY_PORT%...
echo.
set "PORT=%GATEWAY_PORT%"
set "NODE_ENV=development"
node gateway/server.js

echo.
echo [Gateway] Stopped. Cleaning dev service ports...
call :free_port %GATEWAY_PORT%
if "!TIMEFOLD_ENABLED!"=="1" call :free_port %TIMEFOLD_PORT%
if "!MANIM_ENABLED!"=="1" call :free_port %MANIM_PORT%
echo.
pause
exit /b 0

:free_port
set "PORT_TO_FREE=%~1"
for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort %PORT_TO_FREE% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"') do (
    echo [Cleanup] Releasing port %PORT_TO_FREE% from PID %%P...
    taskkill /F /PID %%P >nul 2>&1
)
exit /b 0
