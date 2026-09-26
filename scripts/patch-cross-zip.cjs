// cross-zip@4.0.1 (via @electron-forge/maker-zip) clears the output path on Windows with
// fs.rmdir(path, { recursive: true }), which Node deprecates (DEP0147). No upstream release
// fixes it, so swap in fs.rm with `force` (also ignores a missing path, like the old call).
const fs = require('fs');
const path = require('path');

const targetPath = path.resolve(__dirname, '../node_modules/cross-zip/index.js');

const replacements = [
  [
    'fs.rmdir(outPath, { recursive: true, maxRetries: 3 }, doZip2)',
    'fs.rm(outPath, { recursive: true, force: true, maxRetries: 3 }, doZip2)',
  ],
  [
    'fs.rmdirSync(outPath, { recursive: true, maxRetries: 3 })',
    'fs.rmSync(outPath, { recursive: true, force: true, maxRetries: 3 })',
  ],
];

// Open once and work through the descriptor so the file cannot be swapped
// between the read and the write.
let fd;
try {
  fd = fs.openSync(targetPath, 'r+');
} catch (error) {
  if (error.code === 'ENOENT') process.exit(0);
  throw error;
}

const content = fs.readFileSync(fd, 'utf8');
let patched = content;
for (const [from, to] of replacements) patched = patched.replace(from, to);

if (patched !== content) {
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, patched, 0, 'utf8');
  console.log('Replaced deprecated fs.rmdir recursive calls in cross-zip');
}
fs.closeSync(fd);
