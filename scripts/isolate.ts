import fs from 'fs';
import path from 'path';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

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
    if (restArgs[i] === '--image') imageName = restArgs[i + 1];
    if (restArgs[i] === '--service') serviceName = restArgs[i + 1];
    if (restArgs[i] === '--asset-prefix') assetPrefix = restArgs[i + 1];
}

const absEntryFile = path.resolve(entryFile);
const absOutputDir = path.resolve(outputDir);
const nftFile = absEntryFile + '.nft.json';

if (!existsSync(nftFile)) {
    console.error(`NFT file not found: ${nftFile}`);
    process.exit(1);
}

console.log(`Reading NFT trace from: ${nftFile}`);
const nftContent = JSON.parse(readFileSync(nftFile, 'utf-8'));
const files = nftContent.files || [];
const nftDir = path.dirname(nftFile);

console.log(`Found ${files.length} files to trace.`);

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

if (existsSync(serverJsPath)) {
    console.log(`Found server.js at ${serverJsRel}`);
    copyFile(serverJsPath, absOutputDir, serverJsRel);

    // Patch server.js to respect ASSET_PREFIX
    let serverJsContent = readFileSync(serverJsDest, 'utf-8');
    if (assetPrefix) {
        serverJsContent = serverJsContent.replace(/"assetPrefix"\s*:\s*""/, `"assetPrefix":"${assetPrefix}"`);
        console.log(`Patched server.js with hardcoded assetPrefix: ${assetPrefix}`);
        writeFileSync(serverJsDest, serverJsContent);
    }

    // 2.1 Copy all node_modules from standalone
    const nodeModulesRel = 'node_modules';
    const nodeModulesSrc = path.join(standaloneRoot, nodeModulesRel);

    if (existsSync(nodeModulesSrc)) {
        console.log(`Copying node_modules from ${nodeModulesSrc}`);
        const nodeModulesDest = path.join(absOutputDir, nodeModulesRel);
        cpSync(nodeModulesSrc, nodeModulesDest, { recursive: true, force: true });
    } else {
        console.warn(`Could not find node_modules at ${nodeModulesSrc}`);
    }

    // 2.2 Copy .next directory (manifests, etc.)
    const dotNextRel = path.join(appRootRel, '.next');
    const dotNextSrc = path.join(standaloneRoot, dotNextRel);

    if (existsSync(dotNextSrc)) {
        console.log(`Copying .next directory from ${dotNextSrc}`);
        const dotNextDest = path.join(absOutputDir, dotNextRel);
        cpSync(dotNextSrc, dotNextDest, { recursive: true, force: true });

        // 2.3 Patch client-reference-manifest files
        if (assetPrefix) {
            console.log(`Patching client-reference-manifest files with assetPrefix...`);
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

                    const manifestFiles = findManifestFiles(serverDir);

                    for (const manifestFile of manifestFiles) {
                        let content = readFileSync(manifestFile, 'utf-8');
                        const before = content;

                        content = content.replaceAll('"/_next/static/', '"static/');

                        if (content !== before) {
                            writeFileSync(manifestFile, content);
                        }
                    }
                    console.log(`Patched ${manifestFiles.length} client-reference-manifest files`);
                }
            } catch (e) {
                console.warn(`Warning: Could not patch client-reference-manifest files:`, e);
            }
        }
    } else {
        console.warn(`Could not find .next directory at ${dotNextSrc}`);
    }
} else {
    console.warn(`Could not find server.js at ${serverJsRel}. You might need to add a custom runner.`);
}

// 3. Create Dockerfile
const dockerfileContent = `
FROM node:18-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
CMD ["node", "${serverJsRel}"]
`;

writeFileSync(path.join(absOutputDir, 'Dockerfile'), dockerfileContent.trim());

// 4. Generate Knative Service Config
if (imageName && serviceName) {
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
            - name: HOSTNAME
              value: "0.0.0.0"
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: username
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: password
            - name: DB_HOST
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: host
            - name: DB_NAME
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: database
            - name: DATABASE_URL
              value: "postgresql://$(DB_USER):$(DB_PASSWORD)@$(DB_HOST):5432/$(DB_NAME)"
            ${assetPrefix ? `- name: ASSET_PREFIX
              value: "${assetPrefix}"` : ''}
`;
    writeFileSync(path.join(absOutputDir, 'ksvc.yaml'), ksvcContent.trim());
    console.log(`Generated ksvc.yaml for service: ${serviceName}`);
}

console.log(`Isolation complete. Output at: ${absOutputDir}`);
