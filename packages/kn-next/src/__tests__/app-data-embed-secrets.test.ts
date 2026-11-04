/**
 * planAppData's secrets safeguard: a guard against embedding a credential by
 * accident — through a broad glob, or through a symlink whose own name looks
 * innocent. It is a safeguard, not a guarantee: it matches names, so a secret
 * stored under an ordinary name is not recognised.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planAppData } from "../adapters/app-data-embed.mjs";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function app(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knext-secrets-")));
    temps.push(root);
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
    }
    return root;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SECRET_FILES = [
    ".env",
    ".env.local",
    ".npmrc",
    ".yarnrc.yml",
    ".netrc",
    "_netrc",
    ".pypirc",
    ".git-credentials",
    ".htpasswd",
    ".pgpass",
    "credentials.json",
    "credentials",
    "aws-credentials.json",
    "service-account.json",
    "service-account-prod.json",
    "client_secret.json",
    "secrets.yaml",
    "token.json",
    "tokens.txt",
    "auth.token",
    "id_rsa",
    "id_ed25519",
    "server.pem",
    "server.key",
    "server.p12",
    "server.pfx",
    "store.jks",
    "store.keystore",
    "cert.crt",
    "cert.cer",
    "AuthKey_ABC.p8",
    "terraform.tfvars",
    "prod.tfvars",
    "terraform.tfstate",
    "kubeconfig",
    ".aws/credentials",
    ".aws/config",
    ".ssh/config",
    ".ssh/known_hosts",
    ".kube/config",
    ".docker/config.json",
    ".gnupg/pubring.kbx",
    // shapes a first version of the check let through
    ".envrc",
    ".env-local",
    ".env_prod",
    "clientSecret.json",
    "apitoken.txt",
    "secretKey.json",
    "mysecrets.json",
    "apiKey.json",
    "db-password.txt",
    ".gitconfig",
    ".SSH/config",
    ".AWS/credentials",
    ".Docker/config.json",
    "secrets/db.json",
    "Secrets/db.json",
    "private-tokens/list.json",
    "creds/credentials/x.json",
];

describe("a glob that reaches a secret-looking file fails the build and names it", () => {
    for (const name of SECRET_FILES) {
        it(name, () => {
            const root = app({ [`conf/${name}`]: "S=1", "conf/ok.json": "{}" });
            expect(() =>
                planAppData({ root, includes: ["conf/**/*"] }),
            ).toThrow(
                new RegExp(`look like secrets[\\s\\S]*conf/${escapeRe(name)}`),
            );
        });
    }

    it("ordinary names are not caught", () => {
        const root = app({
            "conf/ok.json": "{}",
            "conf/tokenizer.json": "{}",
            "conf/keyboard.json": "{}",
            "conf/secretary.txt": "x",
            "conf/environment.json": "{}",
        });
        expect(
            planAppData({ root, includes: ["conf/*"] }).files.map((f) => f.rel),
        ).toEqual([
            "conf/environment.json",
            "conf/keyboard.json",
            "conf/ok.json",
            "conf/secretary.txt",
            "conf/tokenizer.json",
        ]);
    });

    it("a credential-named directory under node_modules does not taint a package's own files", () => {
        const root = app({
            "node_modules/jsonwebtoken/data/words.json": "{}",
        });
        expect(
            planAppData({
                root,
                includes: ["node_modules/jsonwebtoken/data/*.json"],
            }).files.map((f) => f.rel),
        ).toEqual(["node_modules/jsonwebtoken/data/words.json"]);
    });

    it("a directory pattern fails the same way", () => {
        const root = app({ "conf/.npmrc": "//registry:_authToken=x" });
        expect(() => planAppData({ root, includes: ["conf"] })).toThrow(
            /conf\/\.npmrc/,
        );
    });
});

describe("symlinks are judged by what they point at", () => {
    it("a link with an innocent name to a secret inside the root fails, naming both", () => {
        const root = app({ "vault/.env": "S=1", "data/ok.json": "{}" });
        symlinkSync(join(root, "vault/.env"), join(root, "data/readme.txt"));
        expect(() => planAppData({ root, includes: ["data/*"] })).toThrow(
            /look like secrets[\s\S]*data\/readme\.txt[\s\S]*vault\/\.env/,
        );
    });

    it("a link to a file under a secret directory fails", () => {
        const root = app({ ".ssh/config": "Host x" });
        mkdirSync(join(root, "data"));
        symlinkSync(join(root, ".ssh/config"), join(root, "data/notes.txt"));
        expect(() => planAppData({ root, includes: ["data/*"] })).toThrow(
            /data\/notes\.txt/,
        );
    });

    it("a link to an ordinary file is embedded once, under its real path, and answers to both names", () => {
        const root = app({ "real/a.json": "{}" });
        mkdirSync(join(root, "data"));
        symlinkSync(join(root, "real/a.json"), join(root, "data/link.json"));
        const plan = planAppData({ root, includes: ["data/*"] });
        expect(plan.files.map((f) => f.rel)).toEqual(["real/a.json"]);
        expect(plan.files[0].aliases).toEqual(["data/link.json"]);
        expect(plan.files[0].abs).toBe(join(root, "real/a.json"));
    });
});

describe("the explicit opt-out", () => {
    it("an exact, non-glob, non-symlink path embeds even a secret-looking name", () => {
        const root = app({ "conf/.env.public": "PUBLIC=1" });
        expect(
            planAppData({ root, includes: ["conf/.env.public"] }).files.map(
                (f) => f.rel,
            ),
        ).toEqual(["conf/.env.public"]);
    });

    it("does not cover a link to a secret", () => {
        const root = app({ "vault/.env": "S=1" });
        mkdirSync(join(root, "data"));
        symlinkSync(join(root, "vault/.env"), join(root, "data/public.txt"));
        expect(() =>
            planAppData({ root, includes: ["data/public.txt"] }),
        ).toThrow(/vault\/\.env/);
    });
});

describe(".git is never embedded", () => {
    it("a sweep prunes it; naming it fails", () => {
        const root = app({
            ".git/config": "[remote]",
            ".git/HEAD": "ref",
            "data/a.json": "{}",
        });
        expect(
            planAppData({ root, includes: ["./**/*"] }).files.map((f) => f.rel),
        ).toEqual(["data/a.json"]);
        expect(() => planAppData({ root, includes: [".git/config"] })).toThrow(
            /never embedded, but .\.git\/config. names it/,
        );
        expect(() => planAppData({ root, includes: [".git"] })).toThrow(
            /never embedded, but .\.git. names it/,
        );
    });

    it("a link into it fails even when the opt-out names the link", () => {
        const root = app({ ".git/config": "[remote]" });
        mkdirSync(join(root, "data"));
        symlinkSync(join(root, ".git/config"), join(root, "data/c.txt"));
        expect(() => planAppData({ root, includes: ["data/c.txt"] })).toThrow(
            /\.git\/config/,
        );
    });
});

describe("literal-path candidates get the same checks (skipped and logged, never embedded)", () => {
    it("a link with an ordinary name into .git is skipped", () => {
        const root = app({ ".git/config": "[x]", "data/ok.json": "{}" });
        symlinkSync(join(root, ".git/config"), join(root, "data/gitlink.txt"));
        const plan = planAppData({
            root,
            includes: [],
            candidates: [
                join(root, "data/gitlink.txt"),
                join(root, "data/ok.json"),
            ],
        });
        expect(plan.files.map((f) => f.rel)).toEqual(["data/ok.json"]);
        expect(plan.skipped.map((s) => s.rel)).toEqual(["data/gitlink.txt"]);
        expect(plan.skipped[0].reason).toMatch(/\.git/);
    });

    it("secret names, links to secrets and .git are skipped with their path", () => {
        const root = app({
            "vault/.env": "S=1",
            ".npmrc": "x",
            "data/ok.json": "{}",
            ".git/config": "[x]",
            "creds/credentials.json": "{}",
        });
        symlinkSync(join(root, "vault/.env"), join(root, "data/fine.txt"));
        const plan = planAppData({
            root,
            includes: [],
            candidates: [
                join(root, ".npmrc"),
                join(root, "data/fine.txt"),
                join(root, ".git/config"),
                join(root, "creds/credentials.json"),
                join(root, "data/ok.json"),
            ],
        });
        expect(plan.files.map((f) => f.rel)).toEqual(["data/ok.json"]);
        expect(plan.skipped.map((s) => s.rel).sort()).toEqual([
            ".git/config",
            ".npmrc",
            "creds/credentials.json",
            "data/fine.txt",
        ]);
    });
});
