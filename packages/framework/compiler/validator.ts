import path from 'node:path';
import fs from 'fs-extra';

export class Validator {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  async validate(): Promise<void> {
    await this.validateAppRouter();
    await this.validatePPR();
  }

  private async validateAppRouter() {
    const pagesDir = path.join(this.projectDir, 'pages');
    const appDir = path.join(this.projectDir, 'app');
    const srcPagesDir = path.join(this.projectDir, 'src', 'pages');
    const srcAppDir = path.join(this.projectDir, 'src', 'app');

    const hasAppDir = (await fs.pathExists(appDir)) || (await fs.pathExists(srcAppDir));
    const hasPagesDir = (await fs.pathExists(pagesDir)) || (await fs.pathExists(srcPagesDir));

    if (!hasAppDir) {
      throw new Error(
        'Validation Failed: Strictly App Router is required, but no "app" directory found.',
      );
    }

    if (hasPagesDir) {
      // Check if pages dir only contains api routes, which might be acceptable,
      // but user said "strictly using app router", so we should probably be strict.
      // However, Next.js often keeps pages/api. Let's check if there are non-api routes.

      const pagesPath = (await fs.pathExists(pagesDir)) ? pagesDir : srcPagesDir;
      const files = await fs.readdir(pagesPath);
      const nonApiFiles = files.filter(
        (f) =>
          f !== 'api' &&
          f !== '_app.tsx' &&
          f !== '_document.tsx' &&
          f !== '_app.js' &&
          f !== '_document.js' &&
          f !== '_app.ts' &&
          f !== '_document.ts',
      );

      if (nonApiFiles.length > 0) {
        throw new Error(
          `Validation Failed: Strictly App Router is required, but "pages" directory contains routes: ${nonApiFiles.join(', ')}. Please migrate them to "app".`,
        );
      }
    }
  }

  private async validatePPR() {
    // We need to check next.config.js for cacheComponents (Next.js 16+) or experimental.ppr (Next.js 14/15)
    // Since we can't easily require() the user's config without potentially crashing or needing dependencies,
    // we will try to read it as text or check the build output if available.
    // A more robust way is to check the build output "prerender-manifest.json" or similar if we run after build.
    // But this validator runs before/during our compile step.

    // Let's try to read next.config.js/mjs/ts
    const configFiles = ['next.config.js', 'next.config.mjs', 'next.config.ts'];
    let configContent = '';

    for (const file of configFiles) {
      const filePath = path.join(this.projectDir, file);
      if (await fs.pathExists(filePath)) {
        configContent = await fs.readFile(filePath, 'utf-8');
        break;
      }
    }

    if (!configContent) {
      console.warn('⚠️  Could not find next.config.js to validate PPR. Assuming it is configured.');
      return;
    }

    // Check for cacheComponents (Next.js 16+) or experimental.ppr (Next.js 14/15)
    const hasPPR =
      /cacheComponents:\s*true/.test(configContent) ||
      /ppr:\s*true/.test(configContent) ||
      /partialPrerendering:\s*true/.test(configContent);

    if (!hasPPR) {
      console.warn(
        '⚠️  Partial Prerendering (PPR) is not enabled. For Next.js 16+, set "cacheComponents: true". For Next.js 14/15, set "experimental.ppr: true".',
      );
    } else {
    }
  }
}
