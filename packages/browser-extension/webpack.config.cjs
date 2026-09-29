const path = require('path');
const fs = require('fs');
const HtmlWebpackPlugin = require('html-webpack-plugin');

class CopyAssetsAndManifestPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap('CopyAssetsAndManifestPlugin', (compilation) => {
      const distDir = compilation.outputOptions.path;
      
      // Copy manifest.json
      const manifestSrc = path.resolve(__dirname, 'manifest.json');
      if (fs.existsSync(manifestSrc)) {
        fs.copyFileSync(manifestSrc, path.join(distDir, 'manifest.json'));
      }

      // Copy assets directory
      const assetsSrc = path.resolve(__dirname, 'assets');
      if (fs.existsSync(assetsSrc)) {
        const assetsDist = path.join(distDir, 'assets');
        fs.mkdirSync(assetsDist, { recursive: true });
        for (const file of fs.readdirSync(assetsSrc)) {
          fs.copyFileSync(path.join(assetsSrc, file), path.join(assetsDist, file));
        }
      }

      // Copy the static DNR rulesets. The manifest names these paths and Chrome loads them
      // from the packaged extension, so they must land verbatim in dist/ next to manifest.json.
      const rulesSrc = path.resolve(__dirname, 'rules');
      if (fs.existsSync(rulesSrc)) {
        const rulesDist = path.join(distDir, 'rules');
        fs.mkdirSync(rulesDist, { recursive: true });
        for (const file of fs.readdirSync(rulesSrc)) {
          fs.copyFileSync(path.join(rulesSrc, file), path.join(rulesDist, file));
        }
      }
    });
  }
}

module.exports = {
  entry: {
    background: './src/background/index.ts',
    content: './src/content/index.ts',
    defusers: './src/content/scriptletInjector.ts',
    popup: './src/popup/index.tsx'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    extensionAlias: {
      // TypeScript, ts-jest and this bundler all have to agree on what `./Foo.js` means.
      // `.tsx` belongs in the `.js` list as much as `.ts` does: without it a component is
      // resolvable by `tsc` and by Jest but not by webpack, which fails the build only.
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx']
    },
    alias: {
      // The element Mini-AI lives in core and is shared with the desktop app. Point
      // the bundler at core's source so the extension never needs core's `dist`
      // built first, and so only this one module (not the whole of core) is bundled.
      '@blockingmachine/core/element-ai': path.resolve(__dirname, '../core/src/ai/elementClassifier.ts')
    }
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              transpileOnly: true
            }
          }
        ],
        exclude: /node_modules/
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  // The popup is a React 19 app, so ~230 KiB minified is the floor for
  // react-dom alone. Budget explicitly above that: the default 244 KiB hint
  // fires on routine UI work and hides genuinely large additions in the noise.
  performance: {
    maxAssetSize: 384 * 1024,
    maxEntrypointSize: 384 * 1024
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/popup/index.html',
      filename: 'popup.html',
      chunks: ['popup']
    }),
    new CopyAssetsAndManifestPlugin()
  ]
};

