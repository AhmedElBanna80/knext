#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveConfig } from "../config";
import { generateLoadTestManifests } from "../generators/loadtest-job";

export async function runLoadTest(
    appName: string,
    targetUrl: string,
    type: "smoke" | "load" | "spike" | "scale-to-zero",
    namespace: string = "default",
) {
    try {
        const config = resolveConfig(process.cwd());

        // Output dir for loadtest manifests
        const outputDir = join(process.cwd(), ".kn-next", "loadtest", appName);
        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }

        // Determine if Prometheus is enabled to pipe metrics to it
        let prometheusUrl: string | undefined;
        if (config.observability?.enabled) {
            prometheusUrl = `http://${config.name}-prometheus.${namespace}.svc.cluster.local:9090`;
        }

        const manifests = generateLoadTestManifests(
            appName,
            namespace,
            targetUrl,
            type,
            prometheusUrl,
        );
        const manifestPath = join(outputDir, `job-${type}-${Date.now()}.yaml`);

        writeFileSync(manifestPath, manifests.join("\\n---\\n"));
        console.log(
            `[kn-next] Generated load test job manifest at ${manifestPath}`,
        );

        // Apply via kubectl
        console.log(`[kn-next] Deploying K6 load test job to cluster...`);
        execSync(`kubectl apply -f ${manifestPath}`, { stdio: "inherit" });
        console.log(
            `[kn-next] Load test job started! You can view progress in the kn-next-admin dashboard or Grafana.`,
        );
    } catch (e: any) {
        console.error(`[kn-next] Failed to start load test:`, e.message);
        process.exit(1);
    }
}

// Execute if run directly
if (import.meta.main) {
    const { values, positionals } = parseArgs({
        options: {
            url: { type: "string", short: "u" },
            type: { type: "string", short: "t" },
            namespace: { type: "string", short: "n", default: "default" },
        },
        strict: false,
        allowPositionals: true,
    });

    const config = resolveConfig(process.cwd());
    const targetUrl = values.url as string;
    const type = (values.type || "smoke") as
        | "smoke"
        | "load"
        | "spike"
        | "scale-to-zero";

    if (!targetUrl) {
        console.error("[kn-next] Error: --url is required");
        process.exit(1);
    }

    runLoadTest(config.name, targetUrl, type, values.namespace as string);
}
