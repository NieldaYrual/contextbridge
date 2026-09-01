#!/bin/bash

echo ""
echo "============================================"
echo "  ContextBridge Chrome Extension Installer"
echo "============================================"
echo ""

# Set installation directory
INSTALL_DIR="$HOME/Library/Application Support/ContextBridge-Extension"

# Check if already installed
if [ -f "$INSTALL_DIR/manifest.json" ]; then
    echo "[!] Extension already installed."
    read -p "Reinstall? (y/n): " choice
    if [ "$choice" != "y" ]; then
        open -a "Google Chrome" "chrome://extensions/"
        exit 0
    fi
    rm -rf "$INSTALL_DIR"
fi

# Create installation directory
echo "[1/4] Creating installation folder..."
mkdir -p "$INSTALL_DIR"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Copy extension files
echo "[2/4] Copying extension files..."
cp -r "$SCRIPT_DIR/icons" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/manifest.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/background.js" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/content.js" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/content-universal.js" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/options.html" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/options.js" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/progress.html" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/progress.js" "$INSTALL_DIR/"

echo "[3/4] Opening extension folder..."
open "$INSTALL_DIR"

echo "[4/4] Opening Chrome extensions page..."
open -a "Google Chrome" "chrome://extensions/"

echo ""
echo "============================================"
echo "       SETUP COMPLETE! FINAL STEPS:"
echo "============================================"
echo ""
echo "  1. Chrome opened to chrome://extensions"
echo "     (If not, open Chrome and go there manually)"
echo ""
echo "  2. Toggle 'Developer mode' ON (top-right switch)"
echo ""
echo "  3. Click 'Load unpacked' (top-left button)"
echo ""
echo "  4. A Finder window opened showing the extension."
echo "     In Chrome's folder dialog, navigate to:"
echo ""
echo "     $INSTALL_DIR"
echo ""
echo "     Or press Cmd+Shift+G and paste the path above."
echo ""
echo "  5. Click 'Select' - DONE!"
echo ""
echo "============================================"
echo ""
read -p "Press Enter to exit..."