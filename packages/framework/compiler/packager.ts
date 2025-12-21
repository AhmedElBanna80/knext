import fs from 'fs-extra';
import path from 'path';
import { RouteGroup } from './splitter';

export class Packager {
    private projectDir: string;
    private nextDir: string;
    private outputDir: string;
    private baseImageName: string;

    constructor(projectDir: string, outputDir: string, baseImageName: string) {
        this.projectDir = projectDir;
        this.nextDir = path.join(projectDir, '.next');
        this.outputDir = outputDir;
        this.baseImageName = baseImageName;
    }

    async package(group: RouteGroup): Promise<string> {
        const groupName = group.name;
        const buildDir = path.join(this.outputDir, 'builds', groupName);
        await fs.ensureDir(buildDir);

        console.log(`Packaging service: ${groupName}...`);

        // 1. Identify Entry Points
        const entryPoints: string[] = [];
        for (const pagePath of group.paths) {
            let pagesPath = pagePath;
            if (pagesPath === '/') pagesPath = '/index';
            let appPath = pagePath;
            if (appPath === '/') appPath = '';

            const candidates = [
                path.join(this.nextDir, 'server', 'pages', `${pagesPath}.js`),
                path.join(this.nextDir, 'server', 'pages', `${pagesPath}.html`),
                path.join(this.nextDir, 'server', 'app', appPath, 'page.js'),
            ];

            for (const c of candidates) {
                if (await fs.pathExists(c)) {
                    entryPoints.push(c);
                    break;
                }
            }
        }

        if (entryPoints.length === 0) {
            console.warn(`No specific entry points found for group ${groupName}. Tracing runtime only.`);
        }

        if (await fs.pathExists(path.join(this.projectDir, 'runner.js'))) {
            entryPoints.push(path.join(this.projectDir, 'runner.js'));
        }

        // 2. Bundle dependencies by copying full node_modules (tracing currently disabled)
        // Note: We intentionally do not run a separate tracer here; the entire node_modules
        // directory is copied into the build output to ensure all dependencies are available.

        console.log(`Copying full node_modules for ${groupName}...`);

        const localNodeModules = path.join(this.projectDir, 'node_modules');
        const rootNodeModules = path.join(this.projectDir, '../../node_modules');

        if (await fs.pathExists(localNodeModules)) {
            await fs.copy(localNodeModules, path.join(buildDir, 'node_modules'));
        } else if (await fs.pathExists(rootNodeModules)) {
            console.log('Local node_modules not found, copying from root...');
            await fs.copy(rootNodeModules, path.join(buildDir, 'node_modules'));
        } else {
            console.warn('Could not find node_modules to copy!');
        }

        // Copy .next/server
        await fs.copy(path.join(this.nextDir, 'server'), path.join(buildDir, '.next', 'server'));

        // Copy entry points if they are not in .next/server
        for (const ep of entryPoints) {
            const rel = path.relative(this.projectDir, ep);
            if (!rel.startsWith('.next') && !rel.startsWith('node_modules')) {
                await fs.copy(ep, path.join(buildDir, rel));
            }
        }

        // 4. Copy Runtime Extras
        const extras = ['public', 'next.config.js', 'package.json', 'runner.js', 'cache-handler.js'];
        for (const extra of extras) {
            const src = path.join(this.projectDir, extra);
            if (await fs.pathExists(src)) {
                await fs.copy(src, path.join(buildDir, extra));
            }
        }

        // Ensure .next/static is copied
        const staticSrc = path.join(this.nextDir, 'static');
        const staticDest = path.join(buildDir, '.next', 'static');
        await fs.ensureDir(path.join(buildDir, '.next'));

        // Use fs.copy for cross-platform compatibility
        try {
            await fs.copy(staticSrc, staticDest);
        } catch (e) {
            console.warn('Failed to copy .next/static', e);
        }

        // Copy routes-manifest.json and other required manifests
        const manifests = ['routes-manifest.json', 'prerender-manifest.json', 'server/pages-manifest.json', 'server/middleware-manifest.json'];
        for (const m of manifests) {
            const src = path.join(this.nextDir, m);
            if (await fs.pathExists(src)) {
                await fs.copy(src, path.join(buildDir, '.next', m));
            }
        }

        // 5. Generate Dockerfile
        const dockerfileContent = `
# Use a build argument to configure the Node.js version (default: 18)
ARG NODE_VERSION=18
FROM node:\${NODE_VERSION}-alpine
WORKDIR /app
ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

# Add nextjs user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy all files
COPY . .

# Set permissions
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "runner.js"]
`;
        await fs.writeFile(path.join(buildDir, 'Dockerfile'), dockerfileContent);

        // 6. Build Docker Image
        let imageName = '';
        const lastSlash = this.baseImageName.lastIndexOf('/');
        const lastColon = this.baseImageName.lastIndexOf(':');
        const hasTag = lastColon > lastSlash;

        const base = hasTag ? this.baseImageName.slice(0, lastColon) : this.baseImageName;
        const tag = hasTag ? this.baseImageName.slice(lastColon + 1) : '';

        if (tag) {
            imageName = `${base}-${groupName}:${tag}`;
        } else {
            imageName = `${base}-${groupName}`;
        }

        console.log(`Building Docker image ${imageName}...`);
        const { exec } = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(exec);

        try {
            await execAsync(`docker build -t ${imageName} .`, { cwd: buildDir });
        } catch (e) {
            console.error(`Failed to build image for ${groupName}`, e);
            throw e;
        }

        return imageName;
    }
}
