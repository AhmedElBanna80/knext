import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
// Portable shell helper (#68) — Node-native, argv-array based, runs on Node + Bun.
// Replaces `import { $ } from "bun"`; this module is on the deploy CLI import
// graph, so a top-level `bun` import would break `node dist/cli/deploy.js`.
import { capture, run } from "../cli/exec";
import type { KnativeNextConfig, StorageConfig } from "../config";
import { createLogger } from "./logger";

const log = createLogger({ module: "asset-upload" });

/**
 * Returns the asset prefix URL from the storage configuration.
 * This is cloud-agnostic — the user declares `publicUrl` in their config.
 *
 * Used as Next.js `assetPrefix` so browsers load static assets
 * (_next/static/*) from the user's object storage bucket.
 */
export function getAssetPrefix(storage: StorageConfig): string {
    return storage.publicUrl;
}

/**
 * Recursively collects all file paths under a directory.
 */
function collectFiles(dir: string, baseDir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectFiles(fullPath, baseDir));
        } else {
            files.push(relative(baseDir, fullPath));
        }
    }
    return files;
}

/**
 * Lists the immediate children of a directory as absolute paths.
 *
 * The Bun shell expanded `dir/*` via the shell glob. With an argv array there
 * is no shell, so we expand the top-level glob here in Node and pass each entry
 * as its own argv token — preserving the original `cp -r dir/* dest/` semantics
 * (copy the contents of dir, not dir itself) without invoking a shell.
 */
function expandTopLevel(dir: string): string[] {
    return readdirSync(dir).map((name) => join(dir, name));
}

/**
 * Uploads static assets to configured storage provider.
 * Assets include _next/static/* and public files.
 *
 * For GCS: also sets public read access, cache-control headers,
 * and verifies all files were uploaded successfully.
 */
export async function uploadAssets(config: KnativeNextConfig): Promise<void> {
    const assetsDir = join(process.cwd(), ".output", "public");

    log.info(
        { provider: config.storage.provider, bucket: config.storage.bucket },
        "Syncing assets to storage",
    );

    const bucket = config.storage.bucket;
    const cacheControl = "Cache-Control:public, max-age=31536000, immutable";

    switch (config.storage.provider) {
        case "gcs": {
            // Upload with cache-control headers for immutable _next/static assets.
            // Glob expanded in Node (see expandTopLevel) — argv, no shell.
            await run(
                [
                    "gsutil",
                    "-m",
                    "-h",
                    cacheControl,
                    "cp",
                    "-r",
                    ...expandTopLevel(assetsDir),
                    `gs://${bucket}/`,
                ],
                { quiet: true },
            );
            // Ensure bucket has public read access for browser fetches
            await run(
                [
                    "gsutil",
                    "iam",
                    "ch",
                    "allUsers:objectViewer",
                    `gs://${bucket}`,
                ],
                { quiet: true },
            );

            // Post-upload verification: ensure all local files exist in GCS
            const localFiles = collectFiles(assetsDir, assetsDir);
            const gcsListResult = await capture([
                "gsutil",
                "ls",
                "-r",
                `gs://${bucket}/`,
            ]);
            const gcsFiles = new Set(
                gcsListResult
                    .split("\n")
                    .filter((line) => line.startsWith("gs://"))
                    .map((line) => line.replace(`gs://${bucket}/`, "")),
            );

            const missing = localFiles.filter((f) => !gcsFiles.has(f));

            if (missing.length > 0) {
                log.warn(
                    { count: missing.length },
                    "Files missing after bulk upload, retrying individually",
                );
                for (const file of missing) {
                    const localPath = join(assetsDir, file);
                    const gcsPath = `gs://${bucket}/${file}`;
                    await run(
                        [
                            "gsutil",
                            "-h",
                            cacheControl,
                            "cp",
                            localPath,
                            gcsPath,
                        ],
                        { quiet: true },
                    );
                }
                log.info(
                    { count: missing.length },
                    "Missing files uploaded successfully",
                );
            }
            break;
        }
        case "s3":
            await run(
                [
                    "aws",
                    "s3",
                    "sync",
                    assetsDir,
                    `s3://${bucket}`,
                    "--cache-control",
                    "public, max-age=31536000, immutable",
                ],
                { quiet: true },
            );
            break;
        case "minio":
            // MinIO uses S3-compatible CLI. Glob expanded in Node — argv, no shell.
            await run(
                [
                    "mc",
                    "cp",
                    "--recursive",
                    ...expandTopLevel(assetsDir),
                    `minio/${bucket}/`,
                ],
                { quiet: true },
            );
            break;
        case "azure":
            await run(
                [
                    "az",
                    "storage",
                    "blob",
                    "upload-batch",
                    "-d",
                    bucket,
                    "-s",
                    assetsDir,
                ],
                { quiet: true },
            );
            break;
        default:
            throw new Error(
                `Unsupported storage provider: ${config.storage.provider}`,
            );
    }
}
