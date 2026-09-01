============================================
   ContextBridge VS Code Extension v1.0.1
============================================

INSTALLATION INSTRUCTIONS
-------------------------

WINDOWS:
  1. Extract this zip file
  2. Double-click "install-vscode.bat"
  3. Follow the on-screen instructions

macOS:
  1. Extract this zip file
  2. Open Terminal
  3. Navigate to the extracted folder:
     cd ~/Downloads/contextbridge-vscode-v1.0.1
  4. Make the script executable:
     chmod +x install-vscode-mac.sh
  5. Run the installer:
     ./install-vscode-mac.sh
  6. Follow the on-screen instructions

MANUAL INSTALLATION (any OS):
  1. Open VS Code
  2. Press Ctrl+Shift+X (Windows) or Cmd+Shift+X (macOS)
  3. Click the "..." menu (top of Extensions sidebar)
  4. Select "Install from VSIX..."
  5. Navigate to and select: contextbridge-codex-0.0.1.vsix
  6. Reload VS Code if prompted

CONFIGURATION:
  1. Press Ctrl+, (Windows) or Cmd+, (macOS) for Settings
  2. Search for "contextbridge"
  3. Set your Project ID (from ContextBridge dashboard)
  4. Optionally configure:
     - API URL (default: https://api.ctxbridge.io)
     - Include/Exclude patterns

USAGE:
  1. Open your project folder in VS Code
  2. Press Ctrl+Shift+P (Windows) or Cmd+Shift+P (macOS)
  3. Type: "ContextBridge: Sync Files Now"
  4. Your code files will sync to your ContextBridge project

AUTOMATIC SYNC:
  The extension automatically syncs files when you:
  - Save a file
  - Create a new file
  - Rename a file
  - Delete a file

SUPPORT:
  If you encounter issues, please contact support.

============================================