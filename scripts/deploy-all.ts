
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Client } from 'minio';

// Configuration
const REGISTRY_BASE = 'local'; // Use 'local' to skip push
const IMAGE_PREFIX = 'dev.local/knative-next';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || '127.0.0.1';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '9000');
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin'; // Warn: Default credentials are not secure for production
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin'; // Warn: Default credentials are not secure for production
const BUCKET_NAME = process.env.MINIO_BUCKET || 'next-assets';
// The asset prefix accessible from inside the cluster (or via Magic DNS)
// Since the browser needs to access it, we use the external Magic URL.
// MinIO Service is at minio.default.svc.cluster.local internally, but browser needs external.
// We'll use the Magic DNS for MinIO too: http://minio.default.127.0.0.1.sslip.io:9000
const ASSET_PREFIX = `http://minio.default.127.0.0.1.sslip.io:9000/${BUCKET_NAME}`;

// Find all page.js files in standalone build
const STANDALONE_ROOT = 'apps/file-manager/.next/standalone';
const APP_DIR = path.join(STANDALONE_ROOT, 'apps/file-manager/.next/server/app');
const STATIC_ASSETS_DIR = 'apps/file-manager/.next/static';

function findPages(dir: string, fileList: string[] = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (!file.startsWith('_')) { // Skip _not-found, _error,etc.
                findPages(filePath, fileList);
            }
        } else if (file === 'page.js') {
            fileList.push(filePath);
        }
    });
    return fileList;
}

(async () => {
    console.log('--- Starting Deployment ---');

    async function uploadAssets() {
        console.log('\n--- Uploading Static Assets to MinIO ---');
        const minioClient = new Client({
            endPoint: MINIO_ENDPOINT,
            port: MINIO_PORT,
            useSSL: false,
            accessKey: MINIO_ACCESS_KEY,
            secretKey: MINIO_SECRET_KEY,
        });

        // Check if MinIO is reachable (simple retry)
        let retries = 5;
        while (retries > 0) {
            try {
                await minioClient.listBuckets();
                break;
            } catch (e) {
                console.log(`Waiting for MinIO... (${retries} retries left)`);
                await new Promise(r => setTimeout(r, 2000));
                retries--;
            }
        }

        if (retries === 0) {
            console.error('Failed to connect to MinIO. Skipping asset upload.');
            return;
        }

        const exists = await minioClient.bucketExists(BUCKET_NAME);
        if (!exists) {
            await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
            console.log(`Created bucket: ${BUCKET_NAME}`);
            // Set policy to public read
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
            console.log('Set bucket policy to public read');
        }

        // Upload files
        // We need to upload .next/static/... to bucket/_next/static/...
        // So prefix in bucket should be "_next/static"
        const uploadDir = async (dir: string, prefix: string) => {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    await uploadDir(filePath, `${prefix}/${file}`);
                } else {
                    const objectName = `${prefix}/${file}`;
                    await minioClient.fPutObject(BUCKET_NAME, objectName, filePath);
                }
            }
        };

        if (fs.existsSync(STATIC_ASSETS_DIR)) {
            console.log(`Uploading ${STATIC_ASSETS_DIR} to ${BUCKET_NAME}/_next/static...`);
            await uploadDir(STATIC_ASSETS_DIR, '_next/static');
            console.log('Asset upload completed.');
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
    }

    const pages = findPages(APP_DIR);
    console.log(`Found ${pages.length} pages to deploy.`);

    pages.forEach(pagePath => {
        // Determine page name from path
        // e.g. .../server/app/dashboard/page.js -> dashboard
        // .../server/app/page.js -> index

        const relPath = path.relative(APP_DIR, pagePath);
        const dirName = path.dirname(relPath);

        let pageName = dirName.replace(/\//g, '-');
        if (dirName === '.') pageName = 'index';

        // Skip internal pages
        // Skips directories starting with underscore like _not-found, _error, etc.
        // Note: _app and _document are usually not standalone pages in App Router but can be in Pages Router.
        // In App Router, we mainly want to skip special Next.js internal folders if they appear here.
        if (pageName.startsWith('_')) {
            console.log(`Skipping internal page: ${pageName}`);
            return;
        }

        console.log(`\n--- Deploying Page: ${pageName} ---`);

        const isolateDir = `dist/isolated/${pageName}`;
        // Use unique tag to force update (bypass IfNotPresent cache issue)
        const TAG = Date.now().toString();
        const imageName = `${IMAGE_PREFIX}-${pageName}:${TAG}`;

        // 1. Isolate
        console.log(`[1/4] Isolating to ${isolateDir}...`);
        const serviceName = `knative-${pageName}`;
        try {
            execSync(`npx ts-node scripts/isolate.ts ${pagePath} ${isolateDir} --image ${imageName} --service ${serviceName} --asset-prefix ${ASSET_PREFIX}`, { stdio: 'inherit' });
        } catch (e) {
            console.error(`Failed to isolate ${pageName}`);
            return;
        }

        // 2. Build Docker image
        console.log(`[2/4] Building Docker image ${imageName}...`);
        try {
            execSync(`docker build -t ${imageName} ${isolateDir}`, { stdio: 'inherit' });
        } catch (e) {
            console.error(`Failed to build ${pageName}`);
            return;
        }

        // 3. Push (Skipped for local)
        if (REGISTRY_BASE !== 'local') {
            console.log(`[3/4] Pushing to ${REGISTRY_BASE}...`);
            try {
                execSync(`docker push ${imageName}`, { stdio: 'inherit' });
            } catch (e) {
                console.error(`Failed to push ${pageName}`);
                return;
            }
        } else {
            console.log(`[3/4] Skipping push (local mode)...`);
        }

        // 4. Deploy (Using generated ksvc.yaml)
        console.log(`[4/4] Deploying Knative Service...`);
        const manifestPath = `${isolateDir}/ksvc.yaml`;

        if (!fs.existsSync(manifestPath)) {
            console.error(`ksvc.yaml not found for ${pageName}`);
            return;
        }

        try {
            execSync(`kubectl apply -f ${manifestPath}`, { stdio: 'inherit' });
            console.log(`Deployed ${serviceName}`);
        } catch (e) {
            console.error(`Failed to deploy ${pageName}`);
        }
    });

    // 5. Output URLs
    console.log('\n--- Deployment Complete ---');
    console.log('Services deployed. Check URLs with: kubectl get ksvc');
    console.log(`Assets served from: ${ASSET_PREFIX}`);

})().catch(console.error);
