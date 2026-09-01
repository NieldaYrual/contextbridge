#!/bin/bash

echo ""
echo "============================================"
echo "  ContextBridge VS Code Extension Installer"
echo "============================================"
echo ""

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VSIX_FILE="$SCRIPT_DIR/contextbridge-codex-0.0.1.vsix"

# Check if vsix file exists
if [ ! -f "$VSIX_FILE" ]; then
    echo "[ERROR] Cannot find extension file:"
    echo "$VSIX_FILE"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

# Check if VS Code CLI is available
if ! command -v code &> /dev/null; then
    echo "[!] VS Code command line 'code' not found."
    echo ""
    echo "MANUAL INSTALLATION:"
    echo "===================="
    echo ""
    echo "  1. Open VS Code"
    echo ""
    echo "  2. Press Cmd+Shift+X (Extensions panel)"
    echo ""
    echo "  3. Click the '...' menu (top of sidebar)"
    echo ""
    echo "  4. Select 'Install from VSIX...'"
    echo ""
    echo "  5. Navigate to this folder:"
    echo "     $SCRIPT_DIR"
    echo ""
    echo "  6. Select: contextbridge-codex-0.0.1.vsix"
    echo ""
    echo "===================="
    echo ""
    echo "TIP: To enable 'code' command for future use:"
    echo "  - Open VS Code"
    echo "  - Press Cmd+Shift+P"
    echo "  - Type: Shell Command: Install 'code' command"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

echo "[1/2] Installing extension..."
echo ""
code --install-extension "$VSIX_FILE"

if [ $? -ne 0 ]; then
    echo ""
    echo "[!] Automatic installation failed."
    echo ""
    echo "Please install manually:"
    echo "  1. Open VS Code"
    echo "  2. Press Cmd+Shift+X"
    echo "  3. Click ... then 'Install from VSIX'"
    echo "  4. Select the .vsix file in this folder"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

echo ""
echo "[2/2] Opening VS Code..."
code

echo ""
echo "============================================"
echo "     Installation Complete!"
echo "============================================"
echo ""
echo "  To configure ContextBridge:"
echo ""
echo "  1. Press Cmd+, to open Settings"
echo ""
echo "  2. Search for 'contextbridge'"
echo ""
echo "  3. Set your Project ID"
echo ""
echo "  4. Press Cmd+Shift+P then type:"
echo "     'ContextBridge: Sync Files Now'"
echo ""
echo "============================================"
echo ""
read -p "Press Enter to exit..."