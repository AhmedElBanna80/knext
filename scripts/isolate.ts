import fs from 'node:fs';
import path from 'node:path';
import { patchManifestJs } from './lib/manifest-patch';

const { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } = fs;

const [, , entryFile, outputDir, ...restArgs] = process.argv;

if (!entryFile || !outputDir) {
  console.error('Usage: npx ts-node scripts/isolate.ts <entry-file> <output-dir>');
  process.exit(1);
}

// Parse arguments manually
let imageName = '';
let serviceName = '';
let assetPrefix = '';

for (let i = 0; i < restArgs.length; i++) {
  const arg = restArgs[i];
  if (arg === '--image') {
    if (i + 1 >= restArgs.length) {
      console.error('Missing value for --image');
      process.exit(1);
    }
    imageName = restArgs[i + 1];
    i++;
  } else if (arg === '--service') {
    if (i + 1 >= restArgs.length) {
      console.error('Missing value for --service');
      process.exit(1);
    }
    serviceName = restArgs[i + 1];
    i++;
  } else if (arg === '--asset-prefix') {
    if (i + 1 >= restArgs.length) {
      console.error('Missing value for --asset-prefix');
      process.exit(1);
    }
    assetPrefix = restArgs[i + 1];
    i++;
  }
}

// If either is provided, require both (used for ksvc.yaml generation).
if ((imageName || serviceName) && (!imageName || !serviceName)) {
  console.error(
    'Usage: npx ts-node scripts/isolate.ts <entry-file> <output-dir> --image <image-name> --service <service-name> [--asset-prefix <asset-prefix>]',
  );
  process.exit(1);
}

const absEntryFile = path.resolve(entryFile);
const absOutputDir = path.resolve(outputDir);
const nftFile = `${absEntryFile}.nft.json`;

if (!existsSync(nftFile)) {
  console.error(`NFT file not found: ${nftFile}`);
  process.exit(1);
}
const nftContent = JSON.parse(readFileSync(nftFile, 'utf-8'));
const files = nftContent.files || [];
const nftDir = path.dirname(nftFile);

// Helper to copy file preserving structure
function copyFile(src: string, destRoot: string, relativePath: string) {
  const destPath = path.join(destRoot, relativePath);
  const destDir = path.dirname(destPath);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  if (existsSync(src)) {
    cpSync(src, destPath);
  } else {
    console.warn(`Warning: File not found ${src}`);
  }
}

// Define common variables
const standaloneMarker = '.next/standalone/';
const markerIndex = absEntryFile.indexOf(standaloneMarker);

if (markerIndex === -1) {
  console.error('Entry file must be inside a .next/standalone directory.');
  process.exit(1);
}

const standaloneRoot = absEntryFile.substring(0, markerIndex + standaloneMarker.length);

// 1. Copy traced files
files.forEach((file: string) => {
  // 'file' is relative to nftDir
  const srcPath = path.resolve(nftDir, file);

  // Now calculate relative path of the srcPath from standaloneRoot
  const relToStandalone = path.relative(standaloneRoot, srcPath);

  if (relToStandalone.startsWith('..')) {
    console.warn(`Skipping file outside standalone root: ${relToStandalone}`);
    return;
  }

  copyFile(srcPath, absOutputDir, relToStandalone);
});

// 2. Find and copy server.js
const relativeEntryDir = path.dirname(path.relative(standaloneRoot, absEntryFile));
const parts = relativeEntryDir.split(path.sep);
const nextIndex = parts.indexOf('.next');
let appRootRel = '';
if (nextIndex !== -1) {
  appRootRel = parts.slice(0, nextIndex).join(path.sep);
}

const serverJsRel = path.join(appRootRel, 'server.js');
const serverJsPath = path.join(standaloneRoot, serverJsRel);
const serverJsDest = path.join(absOutputDir, serverJsRel);
// Docker runs in Linux; ensure CMD uses forward slashes even if this script runs on Windows.
const serverJsRelForDocker = serverJsRel.split(path.sep).join('/');

if (existsSync(serverJsPath)) {
  copyFile(serverJsPath, absOutputDir, serverJsRel);

  // Patch server.js to respect ASSET_PREFIX
  let serverJsContent = readFileSync(serverJsDest, 'utf-8');
  if (assetPrefix) {
    const assetPrefixPattern = /"assetPrefix"\s*:\s*"[^"]*"/;
    if (assetPrefixPattern.test(serverJsContent)) {
      serverJsContent = serverJsContent.replace(
        assetPrefixPattern,
        `"assetPrefix":"${assetPrefix}"`,
      );
      writeFileSync(serverJsDest, serverJsContent);
    } else {
      console.warn('Warning: Could not find "assetPrefix" property to patch in server.js');
    }
  }

  // 2.1 Copy all node_modules from standalone
  const nodeModulesRel = 'node_modules';
  const nodeModulesSrc = path.join(standaloneRoot, nodeModulesRel);

  if (existsSync(nodeModulesSrc)) {
    const nodeModulesDest = path.join(absOutputDir, nodeModulesRel);
    cpSync(nodeModulesSrc, nodeModulesDest, { recursive: true, force: true });
  } else {
    console.warn(`Could not find node_modules at ${nodeModulesSrc}`);
  }

  // 2.2 Copy .next directory (manifests, etc.)
  const dotNextRel = path.join(appRootRel, '.next');
  const dotNextSrc = path.join(standaloneRoot, dotNextRel);

  if (existsSync(dotNextSrc)) {
    const dotNextDest = path.join(absOutputDir, dotNextRel);
    cpSync(dotNextSrc, dotNextDest, { recursive: true, force: true });

    // 2.3 Patch client-reference-manifest files
    if (assetPrefix) {
      try {
        const serverDir = path.join(dotNextDest, 'server');
        if (existsSync(serverDir)) {
          const findManifestFiles = (dir: string): string[] => {
            const results: string[] = [];
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                results.push(...findManifestFiles(fullPath));
              } else if (entry.name.endsWith('client-reference-manifest.js')) {
                results.push(fullPath);
              }
            }
            return results;
          };

          // Limit search to known Next.js output subdirs for performance.
          const searchRoots: string[] = [];
          const appServerDir = path.join(serverDir, 'app');
          const pagesServerDir = path.join(serverDir, 'pages');
          if (existsSync(appServerDir)) searchRoots.push(appServerDir);
          if (existsSync(pagesServerDir)) searchRoots.push(pagesServerDir);
          if (searchRoots.length === 0) searchRoots.push(serverDir);

          const manifestFiles = searchRoots.flatMap(findManifestFiles);

          for (const manifestFile of manifestFiles) {
            const content = readFileSync(manifestFile, 'utf-8');
            const patched = patchManifestJs(content);
            if (patched) writeFileSync(manifestFile, patched);
          }
        }
      } catch (e) {
        console.warn('Warning: Could not patch client-reference-manifest files:', e);
      }
    }
  } else {
    console.warn(`Could not find .next directory at ${dotNextSrc}`);
  }
} else {
  console.warn(
    `Could not find server.js at ${serverJsRel}. You might need to add a custom runner.`,
  );
}

// 3. Create Dockerfile
const dockerfileContent = `
FROM node:18-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
CMD ["node", "${serverJsRelForDocker}"]
`;

writeFileSync(path.join(absOutputDir, 'Dockerfile'), dockerfileContent.trim());

// 4. Generate Knative Service Config
if (imageName && serviceName) {
  const envLines: string[] = [
    `            - name: HOSTNAME
              value: "0.0.0.0"`,
    `            # Prerequisite: a Secret named "db-credentials" with key "database-url" must exist in this namespace.`,
    `            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: database-url`,
  ];

  if (assetPrefix) {
    envLines.push(`            - name: ASSET_PREFIX
              value: "${assetPrefix}"`);
  }

  const ksvcContent = `
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${serviceName}
  namespace: default
spec:
  template:
    metadata:
      annotations:
        client.knative.dev/user-image: ${imageName}
    spec:
      containers:
        - image: ${imageName}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 3000
          env:
${envLines.join('\n')}
`;
  writeFileSync(path.join(absOutputDir, 'ksvc.yaml'), ksvcContent.trim());
}
