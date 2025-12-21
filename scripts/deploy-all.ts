import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'minio';
import { toDns1123Label } from './lib/names';

// MinIO credentials must be set before running this script.
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;

if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
  throw new Error(
    'MINIO_ACCESS_KEY and MINIO_SECRET_KEY environment variables must be set before running this deployment script. ' +
      'Set them in your environment (for example, in a .env file or by exporting them in your shell) and try again.',
  );
}

// Configuration
const REGISTRY_BASE = 'local'; // Use 'local' to skip push
const IMAGE_PREFIX = process.env.IMAGE_PREFIX || 'dev.local/knative-next';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || '127.0.0.1';
const MINIO_PORT = Number.parseInt(process.env.MINIO_PORT || '9000', 10);
const BUCKET_NAME = process.env.MINIO_BUCKET || 'next-assets';
const MINIO_REGION = process.env.MINIO_REGION || 'us-east-1'; // MinIO ignores regions, but some S3 clients require one.
const MINIO_PUBLIC_READ = (process.env.MINIO_PUBLIC_READ || 'true') === 'true';
const MINIO_UPLOAD_FAIL_FAST = (process.env.MINIO_UPLOAD_FAIL_FAST || 'true') === 'true';
// The asset prefix accessible from inside the cluster (or via Magic DNS)
// Since the browser needs to access it, we use the external Magic URL.
// MinIO Service is at minio.default.svc.cluster.local internally, but browser needs external.
// The externally accessible MinIO base URL (browser-facing). Override for non-local clusters.
const MINIO_ASSET_BASE_URL =
  process.env.MINIO_ASSET_BASE_URL || 'http://minio.default.127.0.0.1.sslip.io:9000';
const ASSET_PREFIX = `${MINIO_ASSET_BASE_URL}/${BUCKET_NAME}`;

// Find all page.js files in standalone build
const APP_NAME = process.env.APP_NAME || 'file-manager';
const STANDALONE_ROOT = process.env.STANDALONE_ROOT || `apps/${APP_NAME}/.next/standalone`;
const APP_DIR =
  process.env.APP_DIR || path.join(STANDALONE_ROOT, `apps/${APP_NAME}/.next/server/app`);
const STATIC_ASSETS_DIR = process.env.STATIC_ASSETS_DIR || `apps/${APP_NAME}/.next/static`;

function findPages(dir: string, fileList: string[] = []) {
  const files = fs.readdirSync(dir);
  files.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      if (!file.startsWith('_')) {
        // Skip internal routes like _not-found, _error, etc.
        findPages(filePath, fileList);
      }
    } else if (file === 'page.js') {
      fileList.push(filePath);
    }
  });
  return fileList;
}

(async () => {
  async function uploadAssets() {
    const minioClient = new Client({
      endPoint: MINIO_ENDPOINT,
      port: MINIO_PORT,
      useSSL: false,
      accessKey: MINIO_ACCESS_KEY!,
      secretKey: MINIO_SECRET_KEY!,
    });

    // Check if MinIO is reachable (simple retry)
    let retries = 5;
    while (retries > 0) {
      try {
        await minioClient.listBuckets();
        break;
      } catch (_e) {
        await new Promise((r) => setTimeout(r, 2000));
        retries--;
      }
    }

    if (retries === 0) {
      throw new Error('Failed to connect to MinIO after retries. Aborting deployment.');
    }

    const exists = await minioClient.bucketExists(BUCKET_NAME);
    if (!exists) {
      await minioClient.makeBucket(BUCKET_NAME, MINIO_REGION);

      if (MINIO_PUBLIC_READ) {
        // Security note: this makes all uploaded assets world-readable.
        const policy = {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`],
            },
          ],
        };
        await minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(policy));
      } else {
      }
    }

    // Upload files
    // Upload .next/static/... into the bucket under "static/..." to align with manifest patching.
    const uploadDir = async (dir: string, prefix: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const filePath = path.join(dir, entry.name);

        // Avoid symlink cycles / unexpected traversal.
        if (entry.isSymbolicLink()) {
          console.warn(`Skipping symlink during upload: ${filePath}`);
          continue;
        }

        if (entry.isDirectory()) {
          await uploadDir(filePath, path.posix.join(prefix, entry.name));
          continue;
        }

        if (!entry.isFile()) continue;

        const objectName = path.posix.join(prefix, entry.name);
        try {
          await minioClient.fPutObject(BUCKET_NAME, objectName, filePath);
        } catch (err) {
          console.error(
            `Failed to upload file to MinIO: localPath="${filePath}", objectName="${objectName}", bucket="${BUCKET_NAME}"`,
            err,
          );
          if (MINIO_UPLOAD_FAIL_FAST) throw err;
        }
      }
    };

    if (fs.existsSync(STATIC_ASSETS_DIR)) {
      await uploadDir(STATIC_ASSETS_DIR, 'static');
    } else {
      console.warn(`Static assets dir not found: ${STATIC_ASSETS_DIR}`);
    }
  }

  // Main execution

  // 0. Upload Assets
  // We need to port-forward MinIO to localhost:9000 for this script to work
  // The user or script should ensure port-forward is running.
  // Or we can try to run port-forward in background?
  // For now, let's assume MinIO is accessible at localhost:9000 (LoadBalancer might work if supported, or NodePort)
  // On Docker Desktop, LoadBalancer localhost:9000 works.

  try {
    await uploadAssets();
  } catch (e) {
    console.error('Error uploading assets:', e);
    process.exit(1);
  }

  const pages = findPages(APP_DIR);

  // Use a consistent tag to avoid unbounded image accumulation.
  // Prefer an explicitly provided IMAGE_TAG, then git commit SHA, and finally fall back to 'latest'.
  let TAG: string = process.env.IMAGE_TAG || '';
  if (!TAG) {
    try {
      TAG = execSync('git rev-parse --short HEAD').toString().trim();
    } catch {
      TAG = 'latest';
    }
  }

  pages.forEach((pagePath) => {
    // Determine page name from path
    // e.g. .../server/app/dashboard/page.js -> dashboard
    // .../server/app/page.js -> index

    const relPath = path.relative(APP_DIR, pagePath);
    const dirName = path.dirname(relPath);

    let pageName = dirName.replace(/\//g, '-');
    if (dirName === '.') pageName = 'index';
    pageName = toDns1123Label(pageName);

    // Skip internal pages
    // Skip directories starting with underscore like _not-found, _error, etc.
    // Note: _app and _document are usually not standalone pages in App Router but can be in Pages Router.
    // In App Router, we mainly want to skip special Next.js internal folders if they appear here.
    if (pageName.startsWith('_')) {
      return;
    }

    const isolateDir = `dist/isolated/${pageName}`;
    const imageName = `${IMAGE_PREFIX}-${pageName}:${TAG}`;
    const serviceName = `knative-${pageName}`;
    try {
      execSync(
        `npx ts-node scripts/isolate.ts ${pagePath} ${isolateDir} --image ${imageName} --service ${serviceName} --asset-prefix ${ASSET_PREFIX}`,
        {
          stdio: 'inherit',
          timeout: Number.parseInt(process.env.ISOLATE_TIMEOUT_MS || '0', 10) || undefined,
        },
      );
    } catch (e) {
      console.error(`Failed to isolate ${pageName}`, e);
      return;
    }
    try {
      execSync(`docker build -t ${imageName} ${isolateDir}`, { stdio: 'inherit' });
    } catch (_e) {
      console.error(`Failed to build ${pageName}`);
      return;
    }

    // 3. Push (Skipped for local)
    if (REGISTRY_BASE !== 'local') {
      try {
        execSync(`docker push ${imageName}`, { stdio: 'inherit' });
      } catch (_e) {
        console.error(`Failed to push ${pageName}`);
        return;
      }
    } else {
    }
    const manifestPath = `${isolateDir}/ksvc.yaml`;

    if (!fs.existsSync(manifestPath)) {
      console.error(`ksvc.yaml not found for ${pageName}`);
      return;
    }

    try {
      execSync(`kubectl apply -f ${manifestPath}`, { stdio: 'inherit' });
    } catch (_e) {
      console.error(`Failed to deploy ${pageName}`);
    }
  });
})().catch(console.error);
