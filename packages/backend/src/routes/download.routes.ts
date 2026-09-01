// Download routes for serving extension packages
import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

const router = Router();

// Directory where download files are stored
const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// GET /download/chrome - Download Chrome extension installer (.exe)
router.get('/chrome', (req: Request, res: Response) => {
  const filename = 'ContextBridge-Chrome-Setup.exe';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({
      error: 'File not found',
      message: 'Chrome extension installer not available. Please contact support.'
    });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  
  const fileStream = fs.createReadStream(filepath);
  fileStream.pipe(res);
});

// GET /download/chrome-zip - Download Chrome extension (.zip for manual install)
router.get('/chrome-zip', (req: Request, res: Response) => {
  const filename = 'contextbridge-chrome-latest.zip';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({
      error: 'File not found',
      message: 'Chrome extension package not available. Please contact support.'
    });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  
  const fileStream = fs.createReadStream(filepath);
  fileStream.pipe(res);
});

// GET /download/vscode - Download VS Code extension (.vsix)
router.get('/vscode', (req: Request, res: Response) => {
  const filename = 'contextbridge-codex-0.0.1.vsix';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({
      error: 'File not found',
      message: 'VS Code extension not available. Please contact support.'
    });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  
  const fileStream = fs.createReadStream(filepath);
  fileStream.pipe(res);
});

// GET /download/vscode-zip - Download VS Code extension (.zip with installer)
router.get('/vscode-zip', (req: Request, res: Response) => {
  const filename = 'contextbridge-vscode-latest.zip';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({
      error: 'File not found',
      message: 'VS Code extension package not available. Please contact support.'
    });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  
  const fileStream = fs.createReadStream(filepath);
  fileStream.pipe(res);
});

// GET /download - List available downloads
router.get('/', (req: Request, res: Response) => {
  res.json({
    downloads: [
      {
        name: 'Chrome Extension (Installer)',
        url: '/download/chrome',
        version: '1.0.1',
        filename: 'ContextBridge-Chrome-Setup.exe',
        recommended: true
      },
      {
        name: 'Chrome Extension (Manual)',
        url: '/download/chrome-zip',
        version: '1.0.1',
        filename: 'contextbridge-chrome-latest.zip'
      },
      {
        name: 'VS Code Extension',
        url: '/download/vscode',
        version: '0.0.1',
        filename: 'contextbridge-codex-0.0.1.vsix',
        recommended: true
      },
      {
        name: 'VS Code Extension (Manual)',
        url: '/download/vscode-zip',
        version: '1.0.1',
        filename: 'contextbridge-vscode-latest.zip'
      }
    ]
  });
});

export default router;