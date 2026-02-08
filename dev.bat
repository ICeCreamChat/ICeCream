@echo off
chcp 65001 >nul
title ICeCream Dev Server

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: Silent environment check
where node >nul 2>&1 || (
    echo [X] Node.js not found! Install from https://nodejs.org/
    pause & exit /b 1
)

set PYTHON_OK=0
where python >nul 2>&1 && set PYTHON_OK=1

:: Silent dependency check
if not exist "node_modules" (
    echo [*] Installing dependencies...
    call npm install --silent >nul 2>&1
)

if "%PYTHON_OK%"=="1" (
    if not exist "manim-service\.venv" (
        cd manim-service
        python -m venv .venv >nul 2>&1
        call .venv\Scripts\activate.bat
        pip install -r requirements.txt -q >nul 2>&1
        call deactivate
        cd ..
    )
)

:: Create .env if needed
if not exist ".env" if exist ".env.example" copy .env.example .env >nul

:: Create required directories silently
if not exist "uploads" mkdir uploads >nul 2>&1
if not exist "manim-service\static" mkdir manim-service\static >nul 2>&1
if not exist "manim-service\temp_gen" mkdir manim-service\temp_gen >nul 2>&1

:: Clean up old processes silently
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM python.exe >nul 2>&1
timeout /t 1 /nobreak >nul

:: Clear screen and show clean header
cls
echo.
echo   +-----------------------------------------------------------+
echo   :                                                           :
echo   :    ICeCream Dev Server                                    :
echo   :                                                           :
echo   :    Frontend: http://localhost:3000                        :
echo   :    Manim:    http://localhost:8001                        :
echo   :                                                           :
echo   :    Press Ctrl+C to stop                                   :
echo   :                                                           :
echo   +-----------------------------------------------------------+
echo.
echo   ------------------------- LOGS -----------------------------
echo.

:: Start Manim service in background (silent)
if "%PYTHON_OK%"=="1" (
    if exist "manim-service\main.py" (
        cd manim-service
        start /B cmd /c ".venv\Scripts\activate && python main.py 2>&1" >nul
        cd ..
        timeout /t 2 /nobreak >nul
    )
)

:: Start Gateway with full logging
set DEBUG=icecream:*
set NODE_ENV=development
node gateway/server.js

echo.
echo   [Server stopped]
pause
