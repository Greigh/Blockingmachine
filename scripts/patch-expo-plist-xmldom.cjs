// @expo/plist (used by expo prebuild's iOS plist base mods) calls
// DOMParser.parseFromString(xml) with a single argument. @xmldom/xmldom ≥0.9 —
// forced workspace-wide by the root overrides for @electron/packager's
// plist@3.1.1 — requires an explicit mimeType and throws
// "the provided mimeType "undefined" is not valid", which aborts
// `expo prebuild`/`expo run:ios` before the Info.plist mod completes.
// The same upgrade also rejects an XML declaration that is not at offset 0 —
// the entitlements template carries a leading newline, which 0.8.x tolerated
// — so the patched call trims leading whitespace as well.
//
// The package's own declared range is ^0.8.8 (which tolerated both), so the
// surgical fix is to pass the standard plist MIME type explicitly and strip
// leading whitespace — valid under both 0.8.x and 0.9.x. Skipped silently
// when the call site is already patched or the file layout changes.
const fs = require('fs');
const path = require('path');

const nm = path.resolve(__dirname, '../node_modules');

function findPlistBuild() {
  const roots = [nm];
  for (let depth = 0; depth < 3; depth += 1) {
    const next = [];
    for (const root of roots) {
      const direct = path.join(root, '@expo', 'plist', 'build', 'parse.js');
      if (fs.existsSync(direct)) return direct;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === 'node_modules') next.push(path.join(root, entry.name));
      }
    }
    roots.length = 0;
    roots.push(...next);
  }
  return null;
}

const target = findPlistBuild();
if (!target) {
  console.log('patch-expo-plist-xmldom: @expo/plist not found, nothing to patch');
  process.exit(0);
}
const source = fs.readFileSync(target, 'utf8');
const unpatched = 'new xmldom_1.DOMParser({ errorHandler() { } }).parseFromString(xml)';
const patched = "new xmldom_1.DOMParser({ errorHandler() { } }).parseFromString(xml.trimStart(), 'text/xml')";
if (source.includes(patched)) {
  console.log('patch-expo-plist-xmldom: already patched');
} else if (source.includes(unpatched)) {
  fs.writeFileSync(target, source.replace(unpatched, patched));
  console.log('patched @expo/plist: parseFromString now trims input and passes text/xml');
} else {
  console.warn('patch-expo-plist-xmldom: call site not recognised, no change made');
}
