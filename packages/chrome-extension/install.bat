@echo off
title ContextBridge Chrome Extension Installer
color 0A

echo.
echo  ============================================
echo    ContextBridge Chrome Extension Installer
echo  ============================================
echo.

:: Set installation directory
set "INSTALL_DIR=%LOCALAPPDATA%\ContextBridge-Extension"

:: Check if already installed
if exist "%INSTALL_DIR%\manifest.json" (
    echo  [!] Extension already installed.
    echo.
    choice /C YN /M "Reinstall? (Y/N)"
    if errorlevel 2 goto :show_instructions
    rmdir /s /q "%INSTALL_DIR%" 2>nul
)

:: Create installation directory
echo  [1/4] Creating installation folder...
mkdir "%INSTALL_DIR%" 2>nul

:: Get script directory
set "SCRIPT_DIR=%~dp0"

:: Copy extension files
echo  [2/4] Copying extension files...
xcopy "%SCRIPT_DIR%icons" "%INSTALL_DIR%\icons\" /E /I /Y >nul 2>&1
copy "%SCRIPT_DIR%manifest.json" "%INSTALL_DIR%\" >nul
copy "%SCRIPT_DIR%background.js" "%INSTALL_DIR%\" >nul
copy "%SCRIPT_DIR%content.js" "%INSTALL_DIR%\" >nul
copy "%SCRIPT_DIR%content-universal.js" "%INSTALL_DIR%\" >nul
copy "%SCRIPT_DIR%options.html" "%INSTALL_DIR%\" >nul
copy "%SCRIPT_DIR%options.js" "%INSTALL_DIR%\" >nul
copy "%SCRIPT_DIR%progress.html" "%INSTALL_DIR%\" >nul
copy "%SCRIPT_DIR%progress.js" "%INSTALL_DIR%\" >nul

echo  [3/4] Opening Chrome Extensions page...
:: This command tries to open a new tab in the existing window
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" "chrome://extensions/"


echo  [4/4] Copying folder path to clipboard...
:: Magic trick: Put the path in clipboard so user can just PASTE it
echo %INSTALL_DIR%| clip

:show_instructions
echo.
echo  ============================================
echo        SETUP COMPLETE! FINAL STEPS:
echo  ============================================
echo.
echo  1. Chrome just opened to "chrome://extensions"
echo     (If not, open a new tab and type it in)
echo.
echo  2. Toggle "Developer mode" ON (Top Right switch)
echo.
echo  3. Click "Load unpacked" (Top Left button)
echo.
echo  4. A folder window will pop up.
echo     PASTE the path (Ctrl+V) and hit Enter.
echo     (Or manually find "ContextBridge-Chrome" in Documents)
echo.
echo  5. Click "Select Folder". DONE!
echo.
echo  ============================================
echo.
pause