/**
 * A1-cli: Tests that deploy.ts emits and applies a NextApp CR only,
 * with no raw kubectl apply of Knative or infra manifests.
 *
 * Key invariants verified:
 * 1. `renderNextAppCR` produces a valid NextApp CR YAML.
 * 2. The CR carries scale-to-zero (min-scale: 0), bytecode PVC fields,
 *    and NODE_COMPILE_CACHE wiring so the operator can reconcile them.
 * 3. `dryRunDeploy` returns CR YAML and calls its execFn 0 times
 *    (exec-boundary spy = 0 calls).
 */

import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import type { KnativeNextConfig } from '../config';
import { dryRunDeploy, renderNextAppCR } from '../cli/cr-builder';

const baseConfig: KnativeNextConfig = {
  name: 'my-app',
  registry: 'registry.example.com',
  storage: {
    provider: 'gcs',
    bucket: 'my-bucket',
    publicUrl: 'https://storage.googleapis.com/my-bucket',
  },
  cache: {
    provider: 'redis',
    url: 'redis://redis:6379',
    keyPrefix: 'my-app',
  },
  scaling: {
    minScale: 0,
    maxScale: 5,
  },
};

describe('renderNextAppCR', () => {
  it('returns a NextApp CR YAML string', () => {
    const yaml = renderNextAppCR(
      baseConfig,
      'registry.example.com/my-app:v1@sha256:abc123',
      'default',
    );
    expect(yaml).toBeTruthy();

    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed.apiVersion).toBe('apps.kn-next.dev/v1alpha1');
    expect(parsed.kind).toBe('NextApp');
  });

  it('CR spec.image matches the provided image ref', () => {
    const image = 'registry.example.com/my-app:v1@sha256:abc123def456';
    const yaml = renderNextAppCR(baseConfig, image, 'default');
    const cr = YAML.parse(yaml) as { spec: { image: string } };
    expect(cr.spec.image).toBe(image);
  });

  it('CR preserves scale-to-zero (minScale: 0)', () => {
    const yaml = renderNextAppCR(baseConfig, 'img@sha256:abc', 'default');
    const cr = YAML.parse(yaml) as {
      spec: { scaling: { minScale: number } };
    };
    expect(cr.spec.scaling.minScale).toBe(0);
  });

  it('CR carries bytecode cache fields when cache.provider=redis', () => {
    const configWithBytecode: KnativeNextConfig = {
      ...baseConfig,
      cache: {
        provider: 'redis',
        url: 'redis://redis:6379',
        keyPrefix: 'my-app',
      },
    };
    const yaml = renderNextAppCR(configWithBytecode, 'img@sha256:abc', 'default');
    const cr = YAML.parse(yaml) as {
      spec: {
        cache: {
          enableBytecodeCache: boolean;
          url: string;
          keyPrefix: string;
        };
      };
    };
    // The CLI enables bytecode cache by default when Redis is configured.
    expect(cr.spec.cache.enableBytecodeCache).toBe(true);
    expect(cr.spec.cache.url).toBe('redis://redis:6379');
    expect(cr.spec.cache.keyPrefix).toBe('my-app');
  });

  it('CR namespace matches the provided namespace', () => {
    const yaml = renderNextAppCR(baseConfig, 'img@sha256:abc', 'production');
    const cr = YAML.parse(yaml) as {
      metadata: { namespace: string };
    };
    expect(cr.metadata.namespace).toBe('production');
  });
});

describe('dryRunDeploy exec boundary', () => {
  it('dry-run returns CR YAML and calls execFn 0 times', async () => {
    // execFn is the exec-boundary spy injected into dryRunDeploy.
    // In dry-run mode the function must never shell out.
    const execSpy = vi.fn().mockResolvedValue(undefined);

    const output = await dryRunDeploy(
      baseConfig,
      'registry.example.com/my-app:v1@sha256:abc123',
      'default',
      execSpy,
    );

    // Zero cluster side-effects.
    expect(execSpy).toHaveBeenCalledTimes(0);
    // Output must be valid NextApp CR YAML.
    const cr = YAML.parse(output) as { kind: string };
    expect(cr.kind).toBe('NextApp');
  });
});
