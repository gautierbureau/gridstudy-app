/**
 * Copyright (c) 2024, RTE (http://www.rte-france.com)
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import react from '@vitejs/plugin-react';
import { CommonServerOptions, defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import svgr from 'vite-plugin-svgr';
import tsconfigPaths from 'vite-tsconfig-paths';

const serverSettings: CommonServerOptions = {
    port: 3004,
    proxy: {
        '/api/gateway': {
            target: 'http://localhost:9000',
            rewrite: (url: string) => url.replace(/^\/api\/gateway/, ''),
        },
        '/ws/gateway': {
            target: 'http://localhost:9000',
            rewrite: (url: string) => url.replace(/^\/ws\/gateway/, ''),
            ws: true,
        },
    },
};

export default defineConfig((_config) => ({
    define: {
        // Work around react-draggable accessing process.env in browser bundles:
        // https://github.com/react-grid-layout/react-draggable/issues/806
        'process.env.DRAGGABLE_DEBUG': false,
    },
    plugins: [
        react(),
        process.env.VITE_CHECKER_ENABLED === 'true' &&
            checker({
                // TypeScript checking
                typescript: true,

                // ESLint checking
                eslint: {
                    useFlatConfig: true,
                    lintCommand: 'eslint . --max-warnings 0',
                    dev: {
                        logLevel: ['error', 'warning'],
                    },
                    watchPath: './src',
                },

                overlay: false, // Disable overlay in browser

                // Show errors in terminal
                terminal: true,

                // Disable during build because vite-plugin-checker runs checks in a parallel worker,
                // which doesn't block the build if linting or type checking fails. To ensure build
                // failure on errors, we use the 'prebuild' script instead (runs before 'npm run build').
                enableBuild: false,
            }),
        svgr(), // works on every import with the pattern "**/*.svg?react"
        tsconfigPaths(), // to resolve absolute path via tsconfig cf https://stackoverflow.com/a/68250175/5092999
    ],
    base: './',
    server: serverSettings, // for npm run start
    preview: serverSettings, // for npm run serve (use local build)
    build: {
        outDir: 'build',
        rollupOptions: {
            output: {
                // Split the biggest, rarely-changing vendors into their own chunks so that
                // (a) app-code changes don't bust the cached vendor payload and
                // (b) lazily-imported subtrees keep their heavy vendors out of the entry chunk.
                // Only self-contained libraries may be listed here: assigning a library that
                // shares dependencies with the app (e.g. @powsybl/network-viewer, which imports
                // react/@mui) makes rollup hoist those shared dependencies into the manual chunk,
                // turning it into a static dependency of the entry and defeating lazy loading.
                manualChunks(id: string) {
                    // Tiny dependency-free helpers shared across many packages: give them a
                    // stable micro-chunk. Otherwise rollup may co-locate them inside one of the
                    // big vendor chunks below, making that whole chunk a static dependency of
                    // every chunk using the helper (e.g. the entry pulling 1.6MB of map-gl just
                    // for vite's dynamic-import preload helper).
                    if (
                        id.includes('@babel/runtime/') ||
                        id === '\0vite/preload-helper.js' ||
                        id === '\0commonjsHelpers.js'
                    ) {
                        return 'vendor-helpers';
                    }
                    if (!id.includes('node_modules')) {
                        return undefined;
                    }
                    if (id.includes('plotly.js')) {
                        return 'vendor-plotly';
                    }
                    if (id.includes('ag-grid')) {
                        return 'vendor-ag-grid';
                    }
                    if (
                        id.includes('maplibre-gl') ||
                        id.includes('deck.gl') ||
                        id.includes('@luma.gl') ||
                        id.includes('@loaders.gl')
                    ) {
                        return 'vendor-map-gl';
                    }
                    if (id.includes('node_modules/mathjs/')) {
                        return 'vendor-mathjs';
                    }
                    return undefined;
                },
            },
        },
    },
}));
