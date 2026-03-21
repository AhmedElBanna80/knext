import type { KnativeNextConfig } from '@kn-next/config';

const config: KnativeNextConfig = {
  name: 'kn-next-admin',
  registry: 'us-central1-docker.pkg.dev/gsw-mcp/knative-next-repo',
  storage: {
    provider: 's3',
    bucket: 'kn-next-admin-assets',
    publicUrl: 'https://storage.googleapis.com/kn-next-admin-assets',
  },
  scaling: {
    minScale: 0, // Admin dashboard can scale to 0 when not in use
    maxScale: 2, // Minimal max scale needed for admin tasks
  },
  admin: {
    enabled: true,
  },
};

export default config;
