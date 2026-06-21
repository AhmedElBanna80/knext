#!/usr/bin/env node
/**
 * kn-next cleanup - Removes Knative services and clears storage
 *
 * Usage:
 *   bun run packages/kn-next/src/cli/cleanup.ts
 *
 * Steps:
 *   1. Load kn-next.config.ts
 *   2. Delete Knative service
 *   3. Clear storage bucket
 */

import type { KnativeNextConfig } from "../config";
import { createLogger } from "../utils/logger";
// Portable shell helper (#68) — Node-native, argv-array based, runs on Node + Bun.
import { run } from "./exec";
// Single source of truth for config loading — also runs validateConfig,
// which cleanup's former private copy skipped (CONFIG-LOAD-DEDUP).
import { loadConfig } from "./shared";

const log = createLogger({ module: "cleanup" });

async function cleanup() {
    log.info("🧹 kn-next cleanup");

    // 1. Load config
    log.info("Loading configuration...");
    const config = await loadConfig();
    log.info(
        {
            app: config.name,
            storage: `${config.storage.provider} (${config.storage.bucket})`,
        },
        "Configuration loaded",
    );

    // 2. Delete Knative service
    log.info("Deleting Knative service...");
    try {
        await run(
            ["kubectl", "delete", "ksvc", config.name, "--ignore-not-found"],
            { quiet: true },
        );
        log.info({ service: config.name }, "Deleted Knative service");
    } catch (_err) {
        log.warn("Service not found or already deleted");
    }

    // 3. Delete infrastructure services (if configured)
    if (config.infrastructure) {
        log.info("Deleting infrastructure services...");
        const q = { quiet: true } as const;
        if (config.infrastructure.postgres?.enabled) {
            await run(
                [
                    "kubectl",
                    "delete",
                    "statefulset",
                    `${config.name}-postgres`,
                    "--ignore-not-found",
                ],
                q,
            );
            await run(
                [
                    "kubectl",
                    "delete",
                    "svc",
                    `${config.name}-postgres`,
                    "--ignore-not-found",
                ],
                q,
            );
            await run(
                [
                    "kubectl",
                    "delete",
                    "pvc",
                    "-l",
                    `app=${config.name}-postgres`,
                    "--ignore-not-found",
                ],
                q,
            );
            log.info("Deleted PostgreSQL");
        }
        if (config.infrastructure.redis?.enabled) {
            await run(
                [
                    "kubectl",
                    "delete",
                    "deployment",
                    `${config.name}-redis`,
                    "--ignore-not-found",
                ],
                q,
            );
            await run(
                [
                    "kubectl",
                    "delete",
                    "svc",
                    `${config.name}-redis`,
                    "--ignore-not-found",
                ],
                q,
            );
            log.info("Deleted Redis");
        }
        if (config.infrastructure.minio?.enabled) {
            await run(
                [
                    "kubectl",
                    "delete",
                    "statefulset",
                    `${config.name}-minio`,
                    "--ignore-not-found",
                ],
                q,
            );
            await run(
                [
                    "kubectl",
                    "delete",
                    "svc",
                    `${config.name}-minio`,
                    "--ignore-not-found",
                ],
                q,
            );
            await run(
                [
                    "kubectl",
                    "delete",
                    "pvc",
                    "-l",
                    `app=${config.name}-minio`,
                    "--ignore-not-found",
                ],
                q,
            );
            log.info("Deleted MinIO");
        }
    }

    // 4. Clear storage bucket
    log.info("Clearing storage bucket...");
    await clearStorage(config);
    log.info({ bucket: config.storage.bucket }, "Storage bucket cleared");

    log.info("✨ Cleanup complete!");
}

async function clearStorage(config: KnativeNextConfig) {
    const bucket = config.storage.bucket;
    switch (config.storage.provider) {
        case "gcs":
            // The former shell used `2>/dev/null || true` to swallow the
            // "no URLs matched" error on an already-empty bucket. With an argv
            // array there is no shell, so we tolerate the non-zero exit here.
            try {
                await run(["gsutil", "-m", "rm", "-r", `gs://${bucket}/**`], {
                    quiet: true,
                });
            } catch {
                // already empty / nothing matched — non-fatal, same as `|| true`.
            }
            break;
        case "s3":
            await run(["aws", "s3", "rm", `s3://${bucket}`, "--recursive"], {
                quiet: true,
            });
            break;
        case "minio":
            await run(
                ["mc", "rm", "--recursive", "--force", `minio/${bucket}`],
                { quiet: true },
            );
            break;
        case "azure":
            await run(["az", "storage", "blob", "delete-batch", "-s", bucket], {
                quiet: true,
            });
            break;
    }
}

// Run
try {
    await cleanup();
} catch (err) {
    log.fatal({ err }, "Cleanup failed");
    process.exit(1);
}
