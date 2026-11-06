/**
 * A taken PORT on the vinext/nitro target.
 *
 * The Nitro server bundles `srvx` 0.11.x, whose auto-listen is
 * `this.serve().catch(() => {})`: an EADDRINUSE on listen is swallowed, nothing
 * keeps the event loop alive, and the process exits 0 printing nothing. In a
 * pod that is a restart loop with nothing to read.
 *
 * knext's scaffolded entries (`knext-node-entry.mjs`, `knext-bun-entry.mjs`)
 * must not inherit that: a port that cannot be bound is a non-zero exit with a
 * log line naming the port, whatever srvx version sits underneath.
 *
 * Each case boots the REAL scaffolded entry, unmodified, under the real runtime
 * (node, or bun) over the real srvx; only the build-time imports (nitro's
 * virtual polyfills and app, vinext's request context, two @getknext/core
 * internals) are stubbed, as in malformed-url-guard.test.ts. Both halves are
 * pinned: a held port fails loudly, a free port starts and serves.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pickServerPort } from "./helpers/free-port";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const TEMPLATES = join(REPO_ROOT, "packages/kn-next/templates/app");

const tmp = mkdtempSync(join(tmpdir(), "knext-taken-port-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let dirs = 0;

// h3 as a vinext app resolves it (nitro's dependency).
const H3_PATH = createRequire(
    `${realpathSync(join(REPO_ROOT, "apps/file-manager/node_modules/nitro"))}/package.json`,
).resolve("h3");

type Target = "node" | "bun";
const ENTRY: Record<Target, string> = {
    node: "knext-node-entry.mjs",
    bun: "knext-bun-entry.mjs",
};

/** The scaffolded entry, unmodified, with only its build-time imports stubbed. */
function writeEntryApp(target: Target, silentSrvx = false): string {
    const dir = join(tmp, `${target}-${++dirs}`);
    mkdirSync(dir);
    const w = (rel: string, text: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
    };
    copyFileSync(
        join(TEMPLATES, `${ENTRY[target]}.hbs`),
        join(dir, ENTRY[target]),
    );
    copyFileSync(
        join(TEMPLATES, "runtime-contract.mjs.hbs"),
        join(dir, "runtime-contract.mjs"),
    );
    w(
        "package.json",
        JSON.stringify({
            type: "module",
            imports: { "#nitro/virtual/polyfills": "./stub-polyfills.mjs" },
        }),
    );
    w("stub-polyfills.mjs", "");
    const pkg = (name: string, exportsMap: Record<string, string>) =>
        w(
            `node_modules/${name}/package.json`,
            JSON.stringify({ name, type: "module", exports: exportsMap }),
        );
    pkg("sharp", { ".": "./index.mjs" });
    w("node_modules/sharp/index.mjs", "export default {};\n");
    pkg("nitro", { "./app": "./app.mjs" });
    w(
        "node_modules/nitro/app.mjs",
        `import { H3 } from ${JSON.stringify(pathToFileURL(H3_PATH).href)};\n` +
            "const app = new H3().get('/**', () => 'ok');\n" +
            "export const useNitroApp = () => ({ fetch: app.fetch });\n",
    );
    pkg("vinext", { "./shims/request-context": "./request-context.mjs" });
    w(
        "node_modules/vinext/request-context.mjs",
        "export const runWithExecutionContext = (_ctx, fn) => fn();\n",
    );
    pkg("@getknext/core", {
        "./internal/vinext-image-optimizer": "./image.mjs",
        "./internal/response-cache-control": "./cache-control.mjs",
        "./internal/arp-primer": "./arp-primer.mjs",
    });
    w(
        "node_modules/@getknext/core/image.mjs",
        "export const handleImageRequest = async () => null;\n",
    );
    w(
        "node_modules/@getknext/core/cache-control.mjs",
        "export const applyVinextDeployDefault = () => {};\n" +
            "export const cacheControlMiddleware = () => (_req, next) => next();\n",
    );
    w("node_modules/@getknext/core/arp-primer.mjs", "");
    if (silentSrvx) {
        // A srvx that swallows its own listen failure and leaves nothing
        // running, as 0.11's auto-listen does. node: ready() never settles.
        // bun: serve() ends the process with exit code 0.
        pkg("srvx", { "./node": "./node.mjs", "./bun": "./bun.mjs" });
        w(
            "node_modules/srvx/node.mjs",
            "export const serve = () => ({ ready: () => new Promise(() => {}), close: async () => {}, node: {} });\n",
        );
        w(
            "node_modules/srvx/bun.mjs",
            "export const serve = () => { process.exit(0); };\n",
        );
    } else {
        symlinkSync(
            realpathSync(
                join(REPO_ROOT, "apps/file-manager/node_modules/srvx"),
            ),
            join(dir, "node_modules/srvx"),
        );
    }
    return dir;
}

interface Run {
    out: () => string;
    exit: Promise<{ code: number | null; signal: string | null }>;
    /** Resolves with the app port once the entry reports LISTENING. */
    listening: Promise<number>;
    stop: () => void;
}

function run(target: Target, port: number, silentSrvx = false): Run {
    const dir = writeEntryApp(target, silentSrvx);
    const child = spawn(
        target === "bun" ? "bun" : "node",
        [join(dir, ENTRY[target])],
        {
            cwd: dir,
            env: {
                ...process.env,
                PORT: String(port),
                METRICS_PORT: "0",
                HOSTNAME: "127.0.0.1",
                KNEXT_EAGER_WARM: "0",
                NODE_ENV: "production",
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let out = "";
    let onListening: (p: number) => void = () => {};
    const listening = new Promise<number>((r) => {
        onListening = r;
    });
    const onData = (d: Buffer) => {
        out += d.toString();
        const m = out.match(/LISTENING:(\d+)/);
        if (m) onListening(Number(m[1]));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const exit = new Promise<{ code: number | null; signal: string | null }>(
        (r) => child.on("exit", (code, signal) => r({ code, signal })),
    );
    return {
        out: () => out,
        exit,
        listening,
        stop: () => child.kill("SIGKILL"),
    };
}

const holders: Server[] = [];
afterEach(() => {
    for (const h of holders.splice(0)) h.close();
});
/** Hold a port the way another process's listener would (the entry's bind host). */
async function hold(port: number): Promise<void> {
    const s = createServer();
    await new Promise<void>((resolveHold, reject) => {
        s.once("error", reject);
        s.listen({ port, host: "127.0.0.1" }, resolveHold);
    });
    holders.push(s);
}

const timeout = (ms: number, what: string) =>
    new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out: ${what}`)), ms),
    );

for (const target of ["node", "bun"] as const) {
    describe(`the scaffolded ${target} entry, PORT already taken`, () => {
        it("exits non-zero with a log line naming the port", async () => {
            const port = await pickServerPort();
            await hold(port);
            const r = run(target, port);
            try {
                const { code } = await Promise.race([
                    r.exit,
                    timeout(20_000, `exit; output: ${r.out()}`),
                ]);
                expect(code).not.toBe(0);
                expect(code).not.toBeNull();
                expect(r.out()).toContain(
                    `[knext] failed to bind the app listener on 127.0.0.1:${port}`,
                );
            } finally {
                r.stop();
            }
        }, 40_000);

        it("never exits 0 before the app listener is up, even if srvx swallows the failure", async () => {
            const port = await pickServerPort();
            const r = run(target, port, true);
            try {
                const { code } = await Promise.race([
                    r.exit,
                    timeout(20_000, `exit; output: ${r.out()}`),
                ]);
                expect(code).not.toBe(0);
                expect(code).not.toBeNull();
                expect(r.out()).toContain(
                    `[knext] exiting before the app listener on 127.0.0.1:${port} was up`,
                );
            } finally {
                r.stop();
            }
        }, 40_000);

        it("starts and serves normally when the port is free", async () => {
            const port = await pickServerPort();
            const r = run(target, port);
            try {
                const bound = await Promise.race([
                    r.listening,
                    r.exit.then((e) => {
                        throw new Error(
                            `exited ${JSON.stringify(e)}: ${r.out()}`,
                        );
                    }),
                    timeout(20_000, `listening; output: ${r.out()}`),
                ]);
                expect(bound).toBe(port);
                const res = await fetch(`http://127.0.0.1:${port}/`);
                expect(res.status).toBe(200);
                expect(await res.text()).toBe("ok");
            } finally {
                r.stop();
            }
        }, 40_000);
    });
}
