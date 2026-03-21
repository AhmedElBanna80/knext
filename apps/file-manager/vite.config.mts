import { nitro } from 'nitro/vite';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.ASSET_PREFIX || '/',
  plugins: [
    vinext({ cacheHandler: './cache-handler.js' }),
    nitro({ plugins: ['./nitro-cache-plugin.ts'] }),
  ],
  resolve: {
    alias: {
      'pino-elasticsearch': './src/mocks/empty.js',
      'thread-stream': './src/mocks/empty.js',
    },
  },
});
