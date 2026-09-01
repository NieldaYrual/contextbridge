/**
 * ContextBridge Chrome Extension Build Script
 * Minifies and obfuscates JS files for production distribution
 */

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

// Configuration
const SOURCE_DIR = __dirname;
const DIST_DIR = path.join(__dirname, 'dist');
const IS_PRODUCTION = process.argv.includes('--production');

// Copyright header to prepend to minified files
const COPYRIGHT_HEADER = `
`;

// Files to process
const JS_FILES = [
  'background.js',
  'content.js',
  'content-universal.js',
  'options.js',
  'progress.js',
  'status-widget.js',
  'injected_interceptor.js'
];

// Files to copy as-is (no processing)
const COPY_FILES = [
  'options.html',
  'progress.html',
  'README.md',
  'LICENSE'
];

// Manifest file depends on build mode
const MANIFEST_FILE = IS_PRODUCTION ? 'manifest-production.json' : 'manifest.json';

// Folders to copy
const COPY_FOLDERS = [
  'icons'
];

// Terser options for obfuscation
const TERSER_OPTIONS = {
  compress: {
    dead_code: true,
    drop_console: IS_PRODUCTION, // Remove console.log in production
    drop_debugger: true,
    passes: 2
  },
  mangle: {
    toplevel: false, // Don't mangle top-level names (Chrome APIs need them)
    properties: false // Don't mangle properties (breaks Chrome extension APIs)
  },
  format: {
    comments: false, // Remove all comments
    preamble: COPYRIGHT_HEADER
  },
  sourceMap: false
};

// Utility functions
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
  console.log(`  📄 Copied: ${path.basename(src)}`);
}

function copyFolder(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyFolder(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
  console.log(`  📁 Copied folder: ${path.basename(src)}/`);
}

async function minifyFile(filename) {
  const srcPath = path.join(SOURCE_DIR, filename);
  const destPath = path.join(DIST_DIR, filename);
  
  if (!fs.existsSync(srcPath)) {
    console.log(`  ⚠️  Skipped (not found): ${filename}`);
    return;
  }
  
  const code = fs.readFileSync(srcPath, 'utf8');
  
  try {
    const result = await minify(code, TERSER_OPTIONS);
    
    if (result.code) {
      fs.writeFileSync(destPath, result.code);
      
      // Calculate size reduction
      const originalSize = Buffer.byteLength(code, 'utf8');
      const minifiedSize = Buffer.byteLength(result.code, 'utf8');
      const reduction = ((1 - minifiedSize / originalSize) * 100).toFixed(1);
      
      console.log(`  ✅ Minified: ${filename} (${reduction}% smaller)`);
    } else {
      throw new Error('No output from terser');
    }
  } catch (error) {
    console.error(`  ❌ Error minifying ${filename}:`, error.message);
    // Fallback: copy original file with header
    fs.writeFileSync(destPath, COPYRIGHT_HEADER + '\n' + code);
    console.log(`  ⚠️  Copied original: ${filename} (minification failed)`);
  }
}

async function build() {
  console.log('\n🔨 ContextBridge Chrome Extension Build\n');
  console.log(`   Mode: ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log(`   Output: ${DIST_DIR}\n`);
  
  // Clean and create dist directory
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true });
  }
  ensureDir(DIST_DIR);
  
  // Copy static files
  console.log('📦 Copying static files...');

  // Copy manifest (use production manifest for production builds)
  const manifestSrc = path.join(SOURCE_DIR, MANIFEST_FILE);
  if (fs.existsSync(manifestSrc)) {
    fs.copyFileSync(manifestSrc, path.join(DIST_DIR, 'manifest.json'));
    console.log(`  📄 Copied: ${MANIFEST_FILE} → manifest.json`);
  }

  for (const file of COPY_FILES) {
    const srcPath = path.join(SOURCE_DIR, file);
    if (fs.existsSync(srcPath)) {
      copyFile(srcPath, path.join(DIST_DIR, file));
    }
  }
  
  // Copy folders
  console.log('\n📁 Copying folders...');
  for (const folder of COPY_FOLDERS) {
    const srcPath = path.join(SOURCE_DIR, folder);
    if (fs.existsSync(srcPath)) {
      copyFolder(srcPath, path.join(DIST_DIR, folder));
    }
  }
  
  // Minify JavaScript files
  console.log('\n🔧 Minifying JavaScript...');
  for (const file of JS_FILES) {
    await minifyFile(file);
  }
  
  // Summary
  console.log('\n✨ Build complete!\n');
  
  if (IS_PRODUCTION) {
    console.log('📝 Production build ready for distribution.');
    console.log('   Run "pnpm run package" to create distributable zip.\n');
  } else {
    console.log('📝 Development build complete.');
    console.log('   Load "dist" folder as unpacked extension in Chrome.\n');
  }
}

// Run build
build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});