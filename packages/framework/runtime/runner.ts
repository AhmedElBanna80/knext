import fs from 'node:fs';
import path from 'node:path';

const HANDLER_PATH = process.env.NEXT_HANDLER_PATH;
const PROJECT_ROOT = process.env.NEXT_PROJECT_ROOT || '.';

async function optimize() {
  if (!HANDLER_PATH) {
    return;
  }

  const manifestPath = path.join(process.cwd(), PROJECT_ROOT, '.next', 'routes-manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.warn(`Manifest not found at ${manifestPath}. Skipping optimization.`);
    return;
  }

  try {
    const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestContent);

    // Filter Static Routes
    const _originalStaticCount = manifest.staticRoutes.length;
    manifest.staticRoutes = manifest.staticRoutes.filter((r: any) => {
      return r.page === HANDLER_PATH || r.page === '/_not-found' || r.page === '/404';
    });

    // Filter Dynamic Routes
    const _originalDynamicCount = manifest.dynamicRoutes.length;
    manifest.dynamicRoutes = manifest.dynamicRoutes.filter((r: any) => {
      return r.page === HANDLER_PATH;
    });

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error('Error optimizing manifest:', error);
  }
}

// Run optimization then start server
optimize().then(() => {
  // We use require to load the server.js which is in the same directory in the container
  try {
    const serverPath = path.join(process.cwd(), PROJECT_ROOT, 'server.js');
    require(serverPath);
  } catch (e) {
    console.error('Failed to start server.js:', e);
    process.exit(1);
  }
});
