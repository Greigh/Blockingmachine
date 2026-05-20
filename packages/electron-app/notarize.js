require('dotenv').config();
const { notarize } = require('electron-notarize');

// Notarization helper for macOS. Reads credentials from environment variables.
// Prefer the canonical names: APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID.
// Fallback to older names if present for backward compatibility.
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;  
  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;

  return await notarize({
    tool: 'notarytool',
    teamId: process.env.APPLE_TEAM_ID || process.env.APPLETEAMID,
    appBundleId: 'com.blockingmachine.app',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID || process.env.APPLEID,
    appleIdPassword: process.env.APPLE_PASSWORD || process.env.APPLEIDPASS,
  });
};