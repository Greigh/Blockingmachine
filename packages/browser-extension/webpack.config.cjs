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
    });
  }
}

module.exports = {
  entry: {
    background: './src/background/index.ts',
    content: './src/content/index.ts',
    popup: './src/popup/index.tsx'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
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
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/popup/index.html',
      filename: 'popup.html',
      chunks: ['popup']
    }),
    new CopyAssetsAndManifestPlugin()
  ]
};

