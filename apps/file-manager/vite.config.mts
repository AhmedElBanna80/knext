import { defineConfig } from 'vite';
import vinext from 'vinext';
import { nitro } from "nitro/vite";

export default defineConfig({
  base: process.env.ASSET_PREFIX || '/',
  plugins: [vinext(), nitro()],
  resolve: {
    alias: {
      'pino-elasticsearch': './src/mocks/empty.js',
      'thread-stream': './src/mocks/empty.js',
    },
  },
});
