#!/usr/bin/env node
/**
 * kn-next CLI — Knative Next.js Deployment Automation
 *
 * Usage:
 *   npx kn-next deploy [options]
 *
 * ADR-0001: The operator is the single source of truth for cluster state.
 * This CLI's job is strictly: build → push → apply the NextApp CR.
 *
 * What was removed (A1-cli):
 * - kubectl apply of raw Knative Service manifests (was deploy.ts:176)
 * - kubectl apply of infrastructure manifests (was deploy.ts:153)
 * - generateKnativeManifest / generateInfrastructure calls
 *
 * The operator reconciles everything from the NextApp CR.
 */

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { KnativeNextConfig } from "../config";
import { getAssetPrefix, uploadAssets } from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import {
    renderNextAppCR,
    resolveDigest,
    validateCRImageRef,
} from "./cr-builder";
// Portable shell helper (#68): Node-native, argv-array based, no shell — runs
// on plain Node and Bun. Replaces `import { $ } from "bun"` / `Bun.spawn`.
import { capture, run } from "./exec";
import { loadConfig } from "./shared";

const log = createLogger({ module: "deploy" });

interface DeployOptions {
    registry?: string;
    bucket?: string;
    tag?: string;
    namespace: string;
    skipBuild: boolean;
    skipUpload: boolean;
    dryRun: boolean;
}

function parseCliArgs(): DeployOptions {
    const { values } = parseArgs({
        options: {
            registry: { type: "string", short: "r" },
            bucket: { type: "string", short: "b" },
            tag: { type: "string", short: "t" },
            namespace: { type: "string", short: "n", default: "default" },
            "skip-build": { type: "boolean", default: false },
            "skip-upload": { type: "boolean", default: false },
            "dry-run": { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: true,
    });

    if (values.help) {
        log.info(
            [
                "kn-next deploy — build → push → apply NextApp CR",
                "",
                "Options:",
                "  -r, --registry  Container registry (overrides config)",
                "  -b, --bucket    Storage bucket (overrides config)",
                "  -t, --tag       Image tag (default: timestamp)",
                "  -n, --namespace Kubernetes namespace (default: default)",
                "  --skip-build    Skip next build step",
                "  --skip-upload   Skip asset upload step",
                "  --dry-run       Print the NextApp CR without applying it",
                "  -h, --help      Show this help",
            ].join("\n"),
        );
        process.exit(0);
    }

    return {
        registry: values.registry || process.env.KN_REGISTRY,
        bucket: values.bucket || process.env.KN_BUCKET,
        tag: values.tag || process.env.KN_IMAGE_TAG,
        namespace: values.namespace || process.env.KN_NAMESPACE || "default",
        skipBuild: values["skip-build"] ?? false,
        skipUpload: values["skip-upload"] ?? false,
        dryRun: values["dry-run"] ?? false,
    };
}

function applyOverrides(
    config: KnativeNextConfig,
    options: DeployOptions,
): KnativeNextConfig {
    const overridden = { ...config };

    if (options.registry) {
        overridden.registry = options.registry;
    }
    if (options.bucket) {
        overridden.storage = { ...overridden.storage, bucket: options.bucket };
    }

    if (process.env.KN_REDIS_URL && overridden.cache?.provider === "redis") {
        overridden.cache = {
            ...overridden.cache,
            url: process.env.KN_REDIS_URL,
        };
    }

    return overridden;
}

async function deploy() {
    const options = parseCliArgs();

    log.info({ dryRun: options.dryRun }, "kn-next deploy");

    // Load config with validation
    const baseConfig = await loadConfig();
    const config = applyOverrides(baseConfig, options);

    if (!options.skipBuild) {
        const assetPrefix = getAssetPrefix(config.storage);
        process.env.ASSET_PREFIX = assetPrefix;
        log.info({ assetPrefix }, "Running next build (output:standalone)...");
        await run(["npm", "run", "build"], { quiet: true });
        log.info(
            "Next.js build complete — standalone output in .next/standalone/",
        );
    }

    const imageTag = options.tag || `${Date.now()}`;
    // taggedRef is the mutable push target — used for docker build/push only.
    // The operator-facing CR image ref MUST be digest-pinned (see resolveDigest below).
    const taggedRef = `${config.registry}/${config.name}:${imageTag}`;

    log.info(
        { image: taggedRef },
        "Image tag resolved (will be digest-pinned after push)",
    );

    // imageRef is what we put in the CR — starts as taggedRef for dry-run,
    // then replaced with the @sha256:-pinned ref after a real push.
    let imageRef = taggedRef;

    if (!options.dryRun) {
        const tasks: Promise<void>[] = [];

        if (!options.skipUpload) {
            log.info("Running parallel tasks: asset upload + Docker build");
            tasks.push(
                (async () => {
                    await uploadAssets(config);
                    log.info("Assets uploaded");
                })(),
            );
        }

        // Write buildx metadata to a temp file so resolveDigest can read
        // containerimage.digest directly — no extra docker inspect round-trip.
        const metadataFilePath = join(
            process.cwd(),
            ".output",
            "buildx-metadata.json",
        );

        log.info("Building & pushing Docker image");
        tasks.push(
            (async () => {
                const repoRoot = resolve(process.cwd(), "../..");
                // --metadata-file writes the buildx result JSON (includes containerimage.digest).
                // argv array — no shell, no injection (taggedRef/paths are single tokens).
                await run([
                    "docker",
                    "buildx",
                    "build",
                    "--platform",
                    "linux/amd64",
                    "-f",
                    `${process.cwd()}/Dockerfile`,
                    "-t",
                    taggedRef,
                    "--push",
                    "--metadata-file",
                    metadataFilePath,
                    repoRoot,
                ]);
                log.info("Docker image built and pushed");
            })(),
        );

        await Promise.all(tasks);

        // Resolve the real content-digest after push so the CR image ref is pinned.
        // PRIMARY: read containerimage.digest from the buildx metadata file (no extra I/O).
        // FALLBACK: docker inspect --format '{{index .RepoDigests 0}}' (if metadata missing).
        // The operator's validateImageRef rejects any ref without @sha256:.
        log.info({ taggedRef }, "Resolving @sha256: digest...");
        const { readFileSync } = await import("node:fs");
        // ExecFn takes an ARGV array — no shell, no injection risk.
        // capture() spawns via node:child_process with shell:false; each element
        // is a separate argv token (works on Node and Bun).
        const execFn = (argv: string[]): Promise<string> => capture(argv);
        const readFileFn = (p: string) => readFileSync(p, "utf-8");
        imageRef = await resolveDigest(
            taggedRef,
            execFn,
            metadataFilePath,
            readFileFn,
        );
        log.info({ imageRef }, "Digest-pinned image ref resolved");

        // Guard: fail fast if digest resolution produced a non-pinned ref.
        validateCRImageRef(imageRef);
    }

    // Render the NextApp CR from config + resolved image.
    // The operator reconciles all cluster resources from this CR.
    // In dry-run mode imageRef is the mutable tag (acceptable for preview only).
    const crYaml = renderNextAppCR(config, imageRef, options.namespace);
    const crPath = join(process.cwd(), ".output", "nextapp-cr.yaml");

    if (options.dryRun) {
        log.info("Dry run — NextApp CR (not applied):");
        // Print to stdout so callers can capture or display it
        process.stdout.write(crYaml);
        log.info("Dry run complete — no cluster changes made");
        return;
    }

    // Write CR to .output/ and apply it — only CR apply, operator handles the rest.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(process.cwd(), ".output"), { recursive: true });
    writeFileSync(crPath, crYaml, "utf-8");

    log.info({ cr: crPath }, "Applying NextApp CR to cluster...");
    await run(["kubectl", "apply", "-f", crPath, "-n", options.namespace]);

    // Wait briefly for the operator to begin reconciling, then read the URL.
    // jsonpath has no surrounding shell quotes here — argv passes it verbatim.
    const result = await capture([
        "kubectl",
        "get",
        "nextapp",
        config.name,
        "-n",
        options.namespace,
        "-o",
        "jsonpath={.status.url}",
    ]);
    log.info(
        { url: result.replace(/'/g, "") },
        "Deployment submitted — operator is reconciling",
    );
}

try {
    await deploy();
} catch (err) {
    log.fatal({ err }, "Deployment failed");
    process.exit(1);
}
