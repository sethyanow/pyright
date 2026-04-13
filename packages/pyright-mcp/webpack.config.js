const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const { cacheConfig, monorepoResourceNameMapper } = require('../../build/lib/webpack');

const outPath = path.resolve(__dirname, 'dist');
const pyrightDist = path.resolve(__dirname, '..', 'pyright', 'dist');

/**@type {(env: any, argv: { mode: 'production' | 'development' | 'none' }) => import('webpack').Configuration}*/
module.exports = (_, { mode }) => {
    return {
        context: __dirname,
        entry: {
            'mcp-server': './src/mcp-server.ts',
            'lsp-client': './src/lsp-client.ts',
            proxy: './src/proxy.ts',
        },
        target: 'node',
        output: {
            filename: '[name].js',
            path: outPath,
            devtoolModuleFilenameTemplate:
                mode === 'development' ? '../[resource-path]' : monorepoResourceNameMapper('pyright-mcp'),
            clean: true,
        },
        devtool: mode === 'development' ? 'source-map' : 'nosources-source-map',
        cache: mode === 'development' ? cacheConfig(__dirname, __filename) : false,
        stats: {
            all: false,
            errors: true,
            warnings: true,
            publicPath: true,
            timings: true,
        },
        resolve: {
            extensions: ['.ts', '.js'],
            // No path aliases needed — pyright-mcp has no tsconfig paths
        },
        externals: {
            fsevents: 'commonjs2 fsevents',
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    loader: 'ts-loader',
                    options: {
                        configFile: 'tsconfig.json',
                    },
                },
                {
                    test: /\.js$/,
                    loader: 'esbuild-loader',
                    options: {
                        target: 'node12',
                    },
                },
            ],
        },
        plugins: [
            new CopyPlugin({
                patterns: [
                    { from: path.join(pyrightDist, 'pyright-langserver.js'), to: outPath },
                    { from: path.join(pyrightDist, 'vendor.js'), to: outPath },
                    { from: path.join(pyrightDist, 'pyright-internal.js'), to: outPath },
                    { from: path.join(pyrightDist, 'typeshed-fallback'), to: path.join(outPath, 'typeshed-fallback') },
                ],
            }),
        ],
    };
};
