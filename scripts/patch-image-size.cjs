// Backwards-compatibility bridge for appdmg with image-size 2.x
// image-size 2.x removed the synchronous and callback file-path API in favor of Buffer-only imageSize.
// appdmg relies on `const sizeOf = require('image-size'); sizeOf(filepath, callback)`.
const fs = require('fs');
const path = require('path');

const targetPath = path.resolve(__dirname, '../node_modules/image-size/dist/cjs/index.js');

if (!fs.existsSync(targetPath)) {
  process.exit(0);
}

const content = fs.readFileSync(targetPath, 'utf8');
if (content.includes('// APPDMG_COMPAT_SHIM')) {
  process.exit(0);
}

const shimCode = `
// APPDMG_COMPAT_SHIM
const fs = require('fs');
const originalLookup = require('./lookup');
const originalTypes = require('./types');

function compatSizeOf(input, callback) {
  if (typeof input === 'string') {
    if (typeof callback === 'function') {
      fs.readFile(input, (err, buffer) => {
        if (err) return callback(err);
        try {
          const res = originalLookup.imageSize(buffer);
          callback(null, res);
        } catch (e) {
          callback(e);
        }
      });
      return;
    }
    const buffer = fs.readFileSync(input);
    return originalLookup.imageSize(buffer);
  }
  return originalLookup.imageSize(input);
}

compatSizeOf.imageSize = originalLookup.imageSize;
compatSizeOf.default = compatSizeOf;
compatSizeOf.disableTypes = originalLookup.disableTypes;
compatSizeOf.types = originalTypes.types;

module.exports = compatSizeOf;
`;

fs.writeFileSync(targetPath, content + shimCode, 'utf8');
console.log('Applied appdmg compatibility shim to image-size 2.x');
