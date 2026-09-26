/** @type {import('@electron-forge/shared-types').ForgeConfig} */
const config = {
  packagerConfig: {
    name: 'Blockingmachine',
    executableName: 'blockingmachine',
    asar: {
      unpack: "**/node_modules/electron-store/**/*"
    },
    extraResource: ['./assets'],
    afterPrune: [
      (buildPath, electronVersion, platform, arch, callback) => {
        require('@electron/rebuild').rebuild({
          buildPath,
          electronVersion,
          arch,
          force: true
        }).then(() => callback()).catch((err) => callback(err));
      }
    ],
    icon: './assets/Blockingmachine',
    osxSign:
      process.platform === 'darwin'
        ? {
            identity: 'Developer ID Application: Greigh Studios LLC (365KR8NF53)',
            hardenedRuntime: true,
            entitlements: 'build/entitlements.mac.plist',
            'entitlements-inherit': 'build/entitlements.mac.plist',
            'gatekeeper-assess': false,
          }
        : undefined,
    // Notarization: prefer canonical env var names, but allow fallbacks for older names
    osxNotarize:
      process.platform === 'darwin' &&
      (process.env.APPLE_ID || process.env.APPLEID)
        ? {
            tool: 'notarytool',
            appleId: process.env.APPLE_ID || process.env.APPLEID,
            // Password may be named APPLE_PASSWORD or APPLE_ID_PASSWORD in older setups
            appleIdPassword:
              process.env.APPLE_PASSWORD || process.env.APPLE_ID_PASSWORD || process.env.APPLEIDPASS,
            teamId: process.env.APPLE_TEAM_ID || process.env.APPLETEAMID,
          }
        : undefined,
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {
        format: 'ULFO',
        name: 'Blockingmachine',
        overwrite: true,
        icon: './assets/Blockingmachine.icns',
        background: './assets/dmg-background.png',
        contents: [
          {
            x: 410,
            y: 150,
            type: 'link',
            path: '/Applications'
          },
          {
            x: 130,
            y: 150,
            type: 'file',
            path: './out/Blockingmachine-darwin-arm64/Blockingmachine.app'
          }
        ]
      }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux']
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'Blockingmachine',
        setupExe: 'BlockingmachineSetup.exe',
        setupIcon: './assets/Blockingmachine.ico',
        iconUrl: 'https://raw.githubusercontent.com/greigh/Blockingmachine/main/packages/electron-app/assets/Blockingmachine.ico'
      }
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          name: 'blockingmachine',
          productName: 'Blockingmachine',
          // Must match packagerConfig.executableName; defaults to the scoped npm name otherwise.
          bin: 'blockingmachine',
          icon: './assets/Blockingmachine.png',
          categories: ['Utility', 'Network'],
          maintainer: 'Greigh Studios LLC <daniel@greighstudios.com>'
        }
      }
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          name: 'blockingmachine',
          productName: 'Blockingmachine',
          // Must match packagerConfig.executableName; defaults to the scoped npm name otherwise.
          bin: 'blockingmachine',
          icon: './assets/Blockingmachine.png',
          categories: ['Utility', 'Network']
        }
      }
    }
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-webpack',
      config: {
        mainConfig: './webpack.main.config.cjs',
        renderer: {
          config: './webpack.renderer.config.cjs',
          entryPoints: [
            {
              html: './src/index.html',
              js: './src/renderer.tsx',
              name: 'main_window',
              preload: {
                js: './src/preload.ts'
              }
            }
          ],
          port: 3000,
          loggerPort: 9000
        },
        devContentSecurityPolicy: "default-src 'self' 'unsafe-inline' data:; script-src 'self' 'unsafe-eval' 'unsafe-inline' data:"
      }
    }
  ]
};

module.exports = config;