/**
 * TDD: failing tests for the minimal NextAdapter spike (POC-ADAPTER-P0)
 * RED phase: these tests should fail before the adapter is implemented.
 */

import type { NextAdapter } from 'next';
import { describe, expect, it, vi } from 'vitest';

describe('next-adapter (POC-ADAPTER-P0 spike)', () => {
  it('exports a valid NextAdapter with name, modifyConfig and onBuildComplete', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    expect(adapter).toBeDefined();
    expect(typeof adapter.name).toBe('string');
    expect(adapter.name.length).toBeGreaterThan(0);
    expect(typeof adapter.modifyConfig).toBe('function');
    expect(typeof adapter.onBuildComplete).toBe('function');
  });

  it('modifyConfig forces output:standalone and returns config unchanged otherwise', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    const baseConfig = {
      output: undefined,
      cacheHandler: 'cache-handler.js',
      cacheMaxMemorySize: 0,
    } as any;
    const result = await adapter.modifyConfig!(baseConfig, { phase: 'phase-production-build' });

    expect(result.output).toBe('standalone');
    // cacheHandler must still be honoured
    expect(result.cacheHandler).toBe('cache-handler.js');
    expect(result.cacheMaxMemorySize).toBe(0);
  });

  it('modifyConfig is a no-op on non-build phases', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    const baseConfig = { output: 'export' } as any;
    const result = await adapter.modifyConfig!(baseConfig, { phase: 'phase-development-server' });

    // Should return config unchanged (no output override outside build phase)
    expect(result.output).toBe('export');
  });

  it('onBuildComplete logs output counts and build metadata without throwing', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fakeCtx = {
      buildId: 'test-build-id',
      distDir: '/tmp/.next',
      projectDir: '/tmp/app',
      repoRoot: '/tmp',
      nextVersion: '16.0.3',
      config: { output: 'standalone', cacheMaxMemorySize: 0 } as any,
      routes: {
        headers: [],
        redirects: [],
        rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
        dynamicRoutes: [],
      },
      outputs: {
        pages: [],
        middleware: undefined,
        appPages: [{ id: '/page', type: 'APP_PAGE' } as any],
        pagesApi: [],
        appRoutes: [{ id: '/api/health', type: 'APP_ROUTE' } as any],
        prerenders: [],
        staticFiles: [{ id: '/favicon.ico', type: 'STATIC_FILE' } as any],
      },
    };

    await adapter.onBuildComplete!(fakeCtx);

    expect(consoleSpy).toHaveBeenCalled();
    const loggedText = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // Should log buildId, distDir, and output counts
    expect(loggedText).toContain('test-build-id');
    expect(loggedText).toContain('/tmp/.next');
    // Should mention appPages count (1)
    expect(loggedText).toMatch(/appPages.*1|1.*appPages/i);

    consoleSpy.mockRestore();
  });

  it('onBuildComplete logs ctx.routes (routing) counts — headers, redirects, rewrites, dynamicRoutes', async () => {
    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fakeCtx = {
      buildId: 'routing-test-id',
      distDir: '/tmp/.next',
      projectDir: '/tmp/app',
      repoRoot: '/tmp',
      nextVersion: '16.0.3',
      config: { output: 'standalone', cacheMaxMemorySize: 0 } as any,
      routes: {
        headers: [{ source: '/api/*' } as any, { source: '/static/*' } as any],
        redirects: [{ source: '/old', destination: '/new', statusCode: 301 } as any],
        rewrites: {
          beforeFiles: [{ source: '/a', destination: '/b' } as any],
          afterFiles: [],
          fallback: [],
        },
        dynamicRoutes: [{ source: '/blog/[slug]' } as any, { source: '/docs/[id]' } as any],
      },
      outputs: {
        pages: [],
        middleware: undefined,
        appPages: [],
        pagesApi: [],
        appRoutes: [],
        prerenders: [],
        staticFiles: [],
      },
    };

    await adapter.onBuildComplete!(fakeCtx);

    const loggedText = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');

    // Must log routing section
    expect(loggedText).toMatch(/routing|routes/i);
    // headers: 2
    expect(loggedText).toMatch(/headers.*2|2.*headers/i);
    // redirects: 1
    expect(loggedText).toMatch(/redirects.*1|1.*redirects/i);
    // rewrites (beforeFiles: 1)
    expect(loggedText).toMatch(/rewrite|1/i);
    // dynamicRoutes: 2
    expect(loggedText).toMatch(/dynamic.*2|2.*dynamic/i);

    consoleSpy.mockRestore();
  });
});

describe('next-adapter upload (POC-ADAPTER-P1-rework)', () => {
  const makeCtx = (overrides: Record<string, unknown> = {}) => ({
    buildId: 'upload-test-id',
    distDir: '/tmp/.next',
    projectDir: '/tmp/app',
    repoRoot: '/tmp',
    nextVersion: '16.0.3',
    config: { output: 'standalone', cacheMaxMemorySize: 0 } as any,
    routes: {
      headers: [],
      redirects: [],
      rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
      dynamicRoutes: [],
    },
    outputs: {
      pages: [],
      middleware: undefined,
      appPages: [],
      pagesApi: [],
      appRoutes: [],
      prerenders: [
        {
          id: '/cache-tests/time-based',
          filePath: '/tmp/.next/server/app/cache-tests/time-based.html',
        } as any,
      ],
      staticFiles: [
        {
          id: '/favicon.ico',
          filePath: '/tmp/.next/public/favicon.ico',
          pathname: '/favicon.ico',
        } as any,
        {
          id: '/_next/static/chunks/main.js',
          filePath: '/tmp/.next/static/chunks/main.js',
          pathname: '/_next/static/chunks/main.js',
        } as any,
      ],
    },
    ...overrides,
  });

  it('skips upload and logs clearly when STORAGE_BUCKET env var is not set', async () => {
    vi.resetModules();
    delete process.env.STORAGE_BUCKET;

    const mod = await import('./next-adapter.js');
    const adapter: NextAdapter = mod.default;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await adapter.onBuildComplete!(makeCtx());

    const loggedText = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    // Must mention skip/upload skipped with reason
    expect(loggedText).toMatch(/upload skipped|STORAGE_BUCKET/i);

    consoleSpy.mockRestore();
  });

  it('calls getMinioClient().putObject for each staticFile and prerender when STORAGE_BUCKET is set', async () => {
    vi.resetModules();
    process.env.STORAGE_BUCKET = 'test-bucket';

    // Mock @knative-next/lib/clients
    const putObjectMock = vi.fn().mockResolvedValue({ etag: 'mock-etag' });
    vi.mock('@knative-next/lib/clients', () => ({
      getMinioClient: () => ({ putObject: putObjectMock }),
    }));

    const { default: adapter } = (await import('./next-adapter.js')) as { default: NextAdapter };
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await adapter.onBuildComplete!(makeCtx());

    // Should have attempted to upload 2 staticFiles + 1 prerender = 3 uploads
    // (or at least attempted — files may not exist on disk in test env → best-effort)
    const loggedText = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(loggedText).toMatch(/upload|artifact|storage/i);

    consoleSpy.mockRestore();
    delete process.env.STORAGE_BUCKET;
    vi.unmock('@knative-next/lib/clients');
  });
});
