const path = require('path');
const webpack = require('webpack');
const { execSync } = require('child_process');
const packageJson = require('./package.json');

// The verdict cache's fingerprint covers model weights, vocabulary and feedback — none of
// which can see a change to the feature-extraction code itself. Stamping the build with the
// git SHA means a new binary is a new cache epoch without a manual VERDICT_CACHE_FORMAT bump:
// dev builds share the dirty-worktree stamp, packaged builds get the commit they were cut from.
let buildId = `v${packageJson.version}`;
try {
  buildId = `${buildId}+${execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()}`;
} catch {
  // Source tarball with no .git: the package version is still a real epoch boundary.
}

/** @type {import('webpack').Configuration} */
module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  devtool: false,
  entry: {
    index: './src/index.ts',
    preload: './src/preload.ts',
    // The classify pass runs off the main thread — see src/classifyWorker.ts.
    classifierWorker: './src/classifyWorker.ts',
    // So does the post-dedup generation pass — see src/outputWorker.ts.
    outputWorker: './src/outputWorker.ts',
    // The managed DNS daemon is spawned as a plain Node script by
    // daemonManager.start() — bundling the built dist ships it inside the
    // package instead of resolving paths that only exist in the monorepo (the
    // packaged "Start Local Daemon" button could never work). The dist entry,
    // not src: ts-loader would pick up the daemon's own tsconfig (rootDir=src)
    // and reject every electron-app file in the program.
    systemDaemon: '../system-daemon/dist/index.js',
    // Same story for the HTTPS filtering engine — filterProxyManager.start()
    // spawns it under ELECTRON_RUN_AS_NODE, and the macOS capture service's
    // launchd plist runs the same bundle as _blockingmachine. Dist entry for
    // the identical tsconfig-rootDir reason.
    filterProxy: '../https-filter/dist/main.js',
  },
  target: 'electron-main',
  output: {
    filename: '[name].cjs',
    path: path.join(__dirname, '.webpack/main'),
    library: {
      type: 'commonjs2'
    }
  },
  module: {
    parser: {
      javascript: {
        // learnedShadow.ts resolves @blockingmachine/core through a runtime
        // createRequire(join(app.getAppPath(), ...)) — deliberately dynamic so
        // it works in dev and inside the packaged asar. `module` is external
        // under electron-main, so the call must reach the bundle untouched;
        // disabling the analysis silences "createRequire failed parsing
        // argument" without changing what is emitted.
        createRequire: false,
      },
    },
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /(node_modules|\.webpack)/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true
          }
        }
      }
    ]
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.json'],
    // Sources that carry the `.js` specifier ESM requires (`./deployRefresh.js` written against
    // `deployRefresh.ts`) resolve through this alias — the same convention the reachability
    // harness relies on when it compiles these files straight to Node-run ESM.
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    },
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  node: {
    __dirname: false,
    __filename: false
  },
  plugins: [
    new webpack.DefinePlugin({
      __BM_BUILD_ID__: JSON.stringify(buildId),
    }),
  ]
};