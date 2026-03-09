import http from "node:http";
import {
    initBytecodeCacheMetrics,
    metricsRegistry,
    recordServerReady,
} from "./bytecode-metrics.ts";

async function main() {
    initBytecodeCacheMetrics();

    // Intercept requests for /metrics before they reach the Nitro server
    const originalCreateServer = http.createServer;

    // @ts-ignore - dynamic override
    http.createServer = function (requestListener?: http.RequestListener) {
        return originalCreateServer((req, res) => {
            if (req.url === "/metrics" && req.method === "GET") {
                res.setHeader("Content-Type", metricsRegistry.contentType);
                metricsRegistry.metrics().then((metrics) => {
                    res.end(metrics);
                });
                return;
            }
            if (requestListener) {
                return requestListener(req, res);
            }
        });
    };

    // Import Nitro server
    // Nitro's node-server preset automatically starts listening
    await import("../server/index.mjs");

    recordServerReady();
    console.info(`[kn-next] Nitro server listening`);
    console.info(
        `[kn-next] Prometheus metrics at /metrics`,
    );

    // Handle graceful shutdown
    const shutdown = () => {
        console.info("[kn-next] Shutting down gracefully...");
        process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

main().catch((err) => {
    console.error("[kn-next] Server startup failed:", err);
    process.exit(1);
});
