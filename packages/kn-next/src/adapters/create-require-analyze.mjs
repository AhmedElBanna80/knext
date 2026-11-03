/**
 * The `createRequire(import.meta.url)` consumer analysis behind the strict
 * require check (#2614; see entry-require-staticize.mjs for the whole
 * mechanism): parse a server-output module with acorn and report, for every
 * call to a `createRequire` import alias that is anchored at `import.meta.url`
 * (or its per-module-merge getter form, `{get value(){return x.url}}.value`),
 * WHERE ITS VALUE GOES.
 *
 *   - `binding`  — assigned to an identifier (`X = create(...)`, or through the
 *     `(() => create(...))()` IIFE rolldown emits): `name` is that identifier.
 *   - `direct`   — called at once (`create(...)(spec)`): `dynamic` is true when
 *     the argument is not one plain string literal, else `spec` is its value.
 *     A dynamic call whose argument is a constant assembled from string literals
 *     (`['io', 'redis'].join('')`, directly or through a name the module binds
 *     once and never reassigns) also carries `folded`, the package name: a
 *     deliberate load of a known package, see `foldSpecifier`.
 *   - `resolve`  — `create(...).resolve(...)`, an existence probe. Accounted for,
 *     never embedded and never strict-failed (Node's own `require.resolve`
 *     idiom, which callers catch).
 *   - `discarded` — its value is provably thrown away: an expression statement,
 *     or a non-final element of a sequence whose own value is discarded. This is
 *     decided from the TREE, so a string, a regex, a `/`, a comment or a long
 *     sibling before it cannot defeat the proof (#2614).
 *   - `handed`   — anything else: returned, passed, stored, the value of an
 *     enclosing expression. Its require cannot be verified, so the caller
 *     reports it as an unrecognised binding.
 *
 * A module acorn cannot parse is reported as `parseError` and never as clean:
 * the caller treats a create it cannot see as unrecognised.
 *
 * ## Why a separate process
 *
 * `entry-require-staticize.mjs` is in the compile script's import closure,
 * which must stay node-builtins-only (the Bun base-executable seal,
 * `bun-base-exe-seam.test.ts`). acorn is a third-party package, so it is run
 * out of process, the same way `asset-anchor-analyze.mjs` is (shipped beside
 * the compile script, fails closed when absent).
 *
 * Script mode: `bun create-require-analyze.mjs < module.js` prints the analysis
 * as JSON. Only when run directly — importing this module has no side effect.
 */

import { parse } from "acorn";

/** Module specifiers whose `createRequire` export is the one we track. */
const CREATE_REQUIRE_SOURCES = new Set(["module", "node:module"]);

/** Keys of an acorn node that never hold child nodes. */
const SKIP_KEYS = new Set(["type", "start", "end"]);

/**
 * Parse as an ES module, then as a classic script for CommonJS-style code (its
 * `with`, legacy octal literals and top-level `return` are not modules). A
 * module that fails both is not analysable.
 */
function parseSource(src) {
    try {
        return parse(src, {
            ecmaVersion: "latest",
            sourceType: "module",
            allowHashBang: true,
            allowAwaitOutsideFunction: true,
        });
    } catch (moduleError) {
        try {
            return parse(src, {
                ecmaVersion: "latest",
                sourceType: "script",
                allowHashBang: true,
                allowReturnOutsideFunction: true,
            });
        } catch {
            throw moduleError;
        }
    }
}

/** `import.meta.url` */
function isImportMetaUrl(node) {
    return (
        node.type === "MemberExpression" &&
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "url" &&
        node.object.type === "MetaProperty" &&
        node.object.meta.name === "import" &&
        node.object.property.name === "meta"
    );
}

/** `{get value(){return <identifier>.url}}.value` — rolldown's per-module-merge getter. */
function isGetterIndirection(node) {
    if (
        node.type !== "MemberExpression" ||
        node.computed ||
        node.property.name !== "value" ||
        node.object.type !== "ObjectExpression" ||
        node.object.properties.length !== 1
    ) {
        return false;
    }
    const prop = node.object.properties[0];
    if (
        prop.type !== "Property" ||
        prop.kind !== "get" ||
        prop.computed ||
        prop.key.name !== "value" ||
        prop.value.type !== "FunctionExpression"
    ) {
        return false;
    }
    const body = prop.value.body.body;
    if (body.length !== 1 || body[0].type !== "ReturnStatement") return false;
    const ret = body[0].argument;
    return (
        ret?.type === "MemberExpression" &&
        !ret.computed &&
        ret.property.name === "url" &&
        ret.object.type === "Identifier"
    );
}

/** The `createRequire(import.meta.url)` call shapes this analysis tracks. */
function isMetaUrlCreate(call) {
    if (call.arguments.length !== 1) return false;
    const arg = call.arguments[0];
    return isImportMetaUrl(arg) || isGetterIndirection(arg);
}

/** A plain string argument's value, or null (a template with no substitution counts). */
function literalSpec(node) {
    if (node.type === "Literal" && typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
        return node.quasis[0].value.cooked;
    }
    return null;
}

/**
 * Whether the value of `node` is provably thrown away: an expression statement,
 * or a non-final element of a sequence whose own value is thrown away.
 */
function isDiscarded(node, parents) {
    const parent = parents.get(node);
    if (!parent) return false;
    if (parent.type === "ExpressionStatement") return true;
    if (parent.type === "SequenceExpression") {
        const expressions = parent.expressions;
        if (node !== expressions[expressions.length - 1]) return true;
        return isDiscarded(parent, parents);
    }
    return false;
}

/**
 * `['io', 'redis'].join('')` -> "ioredis": the one idiom the repo uses to keep a
 * package name invisible to a bundler (@getknext/lib's ioredis loader). Only an
 * array of plain string literals joined with the empty string folds; anything
 * else (a variable element, another separator, a template with substitutions)
 * returns null and the call stays a non-literal require.
 */
function foldJoin(node) {
    if (
        node.type !== "CallExpression" ||
        node.callee.type !== "MemberExpression" ||
        node.callee.computed ||
        node.callee.property.name !== "join" ||
        node.callee.object.type !== "ArrayExpression" ||
        node.arguments.length !== 1 ||
        literalSpec(node.arguments[0]) !== ""
    ) {
        return null;
    }
    let out = "";
    for (const el of node.callee.object.elements) {
        const part = el === null ? null : literalSpec(el);
        if (part === null) return null;
        out += part;
    }
    return out === "" ? null : out;
}

/** Every identifier a binding pattern introduces. */
function patternNames(node, into) {
    if (!node) return;
    switch (node.type) {
        case "Identifier":
            into.push(node.name);
            break;
        case "ObjectPattern":
            for (const p of node.properties) {
                patternNames(p.type === "RestElement" ? p.argument : p.value, into);
            }
            break;
        case "ArrayPattern":
            for (const el of node.elements) patternNames(el, into);
            break;
        case "RestElement":
            patternNames(node.argument, into);
            break;
        case "AssignmentPattern":
            patternNames(node.left, into);
            break;
    }
}

/**
 * Per name: how many times the module binds it, every value written to it by a
 * declarator initialiser or a plain `name = value` assignment (bundler output
 * hoists `let a, b;` and assigns inside a lazy init function), and whether any
 * other write touches it (compound or destructuring assignment, `++`, a `for`
 * target). Scope-blind on purpose (a name bound twice anywhere is simply not
 * foldable), so it can only make the fold refuse, never accept a name that
 * could mean something else.
 */
function bindingFacts(ast) {
    const bound = new Map();
    const writes = new Map();
    const reassigned = new Set();
    const write = (name, value) => writes.set(name, [...(writes.get(name) ?? []), value]);
    const bind = (name) => bound.set(name, (bound.get(name) ?? 0) + 1);
    const stack = [ast];
    while (stack.length > 0) {
        const node = stack.pop();
        const names = [];
        switch (node.type) {
            case "VariableDeclarator":
                patternNames(node.id, names);
                for (const n of names) bind(n);
                if (node.id.type === "Identifier" && node.init) write(node.id.name, node.init);
                break;
            case "FunctionDeclaration":
            case "FunctionExpression":
            case "ArrowFunctionExpression":
                if (node.id) names.push(node.id.name);
                for (const p of node.params) patternNames(p, names);
                for (const n of names) bind(n);
                break;
            case "ClassDeclaration":
            case "ClassExpression":
                if (node.id) bind(node.id.name);
                break;
            case "CatchClause":
                patternNames(node.param, names);
                for (const n of names) bind(n);
                break;
            case "ImportSpecifier":
            case "ImportDefaultSpecifier":
            case "ImportNamespaceSpecifier":
                bind(node.local.name);
                break;
            case "AssignmentExpression":
                if (node.operator === "=" && node.left.type === "Identifier") {
                    write(node.left.name, node.right);
                } else {
                    patternNames(node.left, names);
                    for (const n of names) reassigned.add(n);
                }
                break;
            case "UpdateExpression":
                if (node.argument.type === "Identifier") reassigned.add(node.argument.name);
                break;
            case "ForInStatement":
            case "ForOfStatement":
                if (node.left.type !== "VariableDeclaration") {
                    patternNames(node.left, names);
                    for (const n of names) reassigned.add(n);
                }
                break;
        }
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue;
            const value = node[key];
            for (const child of Array.isArray(value) ? value : [value]) {
                if (child && typeof child.type === "string") stack.push(child);
            }
        }
    }
    return { bound, writes, reassigned };
}

/**
 * The package name a dynamic `create(...)(arg)` argument is built from, when
 * `arg` is the literal-join idiom itself or a name bound exactly once and
 * written exactly once, with that idiom. Null for everything else.
 */
function foldSpecifier(arg, facts) {
    if (arg.type === "Identifier") {
        if (facts.bound.get(arg.name) !== 1 || facts.reassigned.has(arg.name)) return null;
        const writes = facts.writes.get(arg.name) ?? [];
        return writes.length === 1 ? foldJoin(writes[0]) : null;
    }
    return foldJoin(arg);
}

/** Classify one `createRequire(import.meta.url)` call by where its value goes. */
function classify(call, parents, getFacts) {
    let value = call;
    let parent = parents.get(value);

    // rolldown's binding shape: `(() => create(import.meta.url))()`.
    if (parent?.type === "ArrowFunctionExpression" && parent.body === value) {
        const iife = parents.get(parent);
        if (
            iife?.type === "CallExpression" &&
            iife.callee === parent &&
            iife.arguments.length === 0
        ) {
            value = iife;
            parent = parents.get(iife);
        }
    }

    if (
        parent?.type === "VariableDeclarator" &&
        parent.init === value &&
        parent.id.type === "Identifier"
    ) {
        return { kind: "binding", name: parent.id.name };
    }
    if (
        parent?.type === "AssignmentExpression" &&
        parent.operator === "=" &&
        parent.right === value &&
        parent.left.type === "Identifier"
    ) {
        return { kind: "binding", name: parent.left.name };
    }

    if (parent?.type === "CallExpression" && parent.callee === value) {
        if (parent.arguments.length === 1) {
            const spec = literalSpec(parent.arguments[0]);
            if (spec !== null) return { kind: "direct", dynamic: false, spec };
        }
        const folded =
            parent.arguments.length === 1
                ? foldSpecifier(parent.arguments[0], getFacts())
                : null;
        return folded === null
            ? { kind: "direct", dynamic: true, spec: null }
            : { kind: "direct", dynamic: true, spec: null, folded };
    }

    if (
        parent?.type === "MemberExpression" &&
        parent.object === value &&
        !parent.computed &&
        parent.property.name === "resolve" &&
        parents.get(parent)?.type === "CallExpression" &&
        parents.get(parent).callee === parent
    ) {
        return { kind: "resolve" };
    }

    if (isDiscarded(value, parents)) return { kind: "discarded" };
    return { kind: "handed" };
}

/**
 * @param {string} src
 * @returns {{ aliases: string[], sites: object[], parseError: string | null }}
 */
export function analyzeCreateRequire(src) {
    let ast;
    try {
        ast = parseSource(src);
    } catch (err) {
        return { aliases: [], sites: [], parseError: String(err?.message ?? err) };
    }

    const aliases = [];
    for (const node of ast.body) {
        if (node.type !== "ImportDeclaration") continue;
        if (!CREATE_REQUIRE_SOURCES.has(node.source.value)) continue;
        for (const spec of node.specifiers) {
            if (spec.type !== "ImportSpecifier") continue;
            const imported = spec.imported.name ?? spec.imported.value;
            if (imported === "createRequire") aliases.push(spec.local.name);
        }
    }
    if (aliases.length === 0) return { aliases, sites: [], parseError: null };

    // One explicit-stack walk: every node's parent, and every alias call.
    const parents = new Map();
    const calls = [];
    const aliasSet = new Set(aliases);
    const stack = [ast];
    while (stack.length > 0) {
        const node = stack.pop();
        if (
            node.type === "CallExpression" &&
            node.callee.type === "Identifier" &&
            aliasSet.has(node.callee.name) &&
            isMetaUrlCreate(node)
        ) {
            calls.push(node);
        }
        for (const key of Object.keys(node)) {
            if (SKIP_KEYS.has(key)) continue;
            const value = node[key];
            const children = Array.isArray(value) ? value : [value];
            for (const child of children) {
                if (child && typeof child.type === "string") {
                    parents.set(child, node);
                    stack.push(child);
                }
            }
        }
    }

    let facts = null;
    const getFacts = () => {
        facts ??= bindingFacts(ast);
        return facts;
    };
    return {
        aliases,
        sites: calls.map((call) => classify(call, parents, getFacts)),
        parseError: null,
    };
}

// Script mode: `bun create-require-analyze.mjs < module.js`.
if (import.meta.main) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const src = Buffer.concat(chunks).toString("utf8");
    process.stdout.write(JSON.stringify(analyzeCreateRequire(src)));
}
