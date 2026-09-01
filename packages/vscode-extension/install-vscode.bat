@echo off
title ContextBridge VS Code Extension Installer
color 0A

echo.
echo  ============================================
echo   ContextBridge VS Code Extension Installer
echo  ============================================
echo.

:: Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"
set "VSIX_FILE=%SCRIPT_DIR%contextbridge-codex-0.0.1.vsix"

:: Check if vsix file exists
if not exist "%VSIX_FILE%" (
    echo  [ERROR] Cannot find extension file:
    echo  %VSIX_FILE%
    echo.
    pause
    exit /b
)

:: Check if VS Code CLI is available
where code >nul 2>&1
if errorlevel 1 (
    echo  [!] VS Code command line 'code' not found in PATH.
    echo.
    echo  MANUAL INSTALLATION:
    echo  ====================
    echo.
    echo    1. Open VS Code
    echo.
    echo    2. Press Ctrl+Shift+X (Extensions panel)
    echo.
    echo    3. Click the "..." menu (top of sidebar)
    echo.
    echo    4. Select "Install from VSIX..."
    echo.
    echo    5. Navigate to this folder:
    echo       %SCRIPT_DIR%
    echo.
    echo    6. Select: contextbridge-codex-0.0.1.vsix
    echo.
    echo  ====================
    echo.
    echo  TIP: To enable 'code' command for future use:
    echo    - Open VS Code
    echo    - Press Ctrl+Shift+P
    echo    - Type: Shell Command: Install 'code' command
    echo.
    pause
    exit /b
)

echo  [1/2] Installing extension...
echo.
call code --install-extension "%VSIX_FILE%"

if errorlevel 1 (
    echo.
    echo  [!] Automatic installation failed.
    echo.
    echo  Please install manually:
    echo    1. Open VS Code
    echo    2. Press Ctrl+Shift+X
    echo    3. Click ... then "Install from VSIX"
    echo    4. Select the .vsix file in this folder
    echo.
    pause
    exit /b
)

echo.
echo  [2/2] Opening VS Code...
start "" code

echo.
echo  ============================================
echo       Installation Complete!
echo  ============================================
echo.
echo    To configure ContextBridge:
echo.
echo    1. Press Ctrl+, to open Settings
echo.
echo    2. Search for "contextbridge"
echo.
echo    3. Set your Project ID
echo.
echo    4. Press Ctrl+Shift+P then type:
echo       "ContextBridge: Sync Files Now"
echo.
echo  ============================================
echo.
pause