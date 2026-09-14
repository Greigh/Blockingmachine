const { rebuild } = require('@electron/rebuild');
const path = require('path');

async function main() {
  console.log('Rebuilding native modules...');
  try {
    const electronVersion = require('electron/package.json').version;
    await rebuild({
      buildPath: path.resolve(__dirname, '..'),
      electronVersion,
      arch: process.arch,
      force: true,
      useElectronClang: true
    });
    console.log('Rebuild complete!');
  } catch (err) {
    console.error('Rebuild failed:', err);
    process.exit(1);
  }
}

main();