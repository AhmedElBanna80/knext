import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  assetPrefix: process.env.ASSET_PREFIX || '',
  output: 'standalone',
  transpilePackages: ['@knative-next/ui', '@knative-next/lib'],

  webpack: (config) => {
    config.resolve.alias['@knative-next/ui'] = path.join(__dirname, '../../packages/ui/src');
    config.resolve.alias['@knative-next/lib'] = path.join(__dirname, '../../packages/lib/src');
    return config;
  },
};

export default nextConfig;
