#!/usr/bin/env node
/**
 * Mutation proof for the per-app Redis ACL user guards (operator side).
 *
 * Each case deletes or flips one behaviour in the operator source and requires
 * the named test to go RED, by `go test` exit code (never by grepping output).
 * Every anchor must occur exactly once or the run aborts: a silently failed
 * substitution would leave a green run that proves nothing. The file is
 * restored in a `finally`, and the unmutated run must be green first.
 *
 *   node scripts/mutation-prove-2396-redis-acl.mjs
 *
 * Exit 0: every mutation was caught. Exit 1: a mutation survived (a guard is
 * decoration). Exit 2: infrastructure (an anchor missing or ambiguous, or the
 * baseline red).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OP = join(REPO, 'packages/kn-next-operator');
const CTRL = 'internal/controller/';

const cases = [
  {
    name: 'operator drops "time" from the command list',
    file: `${CTRL}redis_acl.go`,
    from: '"hget", "hset", "hdel", "hmget", "hscan", "scan", "eval", "time",',
    to: '"hget", "hset", "hdel", "hmget", "hscan", "scan", "eval",',
    pkg: './internal/controller',
    test: 'TestAppRedisCommandsMatchTheSpike',
  },
  {
    name: 'operator grants INFO',
    file: `${CTRL}redis_acl.go`,
    from: '"client|setinfo",\n\t}',
    to: '"client|setinfo", "info",\n\t}',
    pkg: './internal/controller',
    test: 'TestRedisACLRulesShape',
  },
  {
    name: 'rules lose the deny-all',
    file: `${CTRL}redis_acl.go`,
    from: 'rules = append(rules, "resetchannels", "-@all")',
    to: 'rules = append(rules, "resetchannels")',
    pkg: './internal/controller',
    test: 'TestRedisACLRulesShape',
  },
  {
    name: 'key pattern is not glob-escaped',
    file: `${CTRL}redis_acl.go`,
    from: 'func redisGlobEscape(text string) string { return escapeRedisGlob(text) }',
    to: 'func redisGlobEscape(text string) string { return text }',
    pkg: './internal/controller',
    test: 'TestRedisACLRulesEscapeThePrefixGlob',
  },
  {
    name: 'acl on an unregistered endpoint falls back to the shared credential',
    file: `${CTRL}redis_acl.go`,
    from: '\t\treturn isolationRequiredUnavailable\n',
    to: '\t\treturn isolationShared\n',
    pkg: './internal/controller',
    test: 'TestResolveCacheIsolation',
  },
  {
    name: 'only an exactly equal prefix conflicts',
    file: `${CTRL}redis_acl_reconcile.go`,
    from: 'return a == b || strings.HasPrefix(a, b+":") || strings.HasPrefix(b, a+":")',
    to: 'return a == b',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsPrefixConflict',
  },
  {
    name: 'a pattern the operator cannot parse is treated as no conflict',
    file: `${CTRL}redis_acl_reconcile.go`,
    from: 'if !ok || prefixesOverlap(prefix, other) {',
    to: 'if ok && prefixesOverlap(prefix, other) {',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsUnparseablePatternFailsClosed',
  },
  {
    name: 'a live shared credential is reported as isolated',
    file: `${CTRL}redis_acl_reconcile.go`,
    from: '\tcase live:\n',
    to: '\tcase false:\n',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsSharedCredentialLiveIsNotAnIsolationClaim',
  },
  {
    name: 'userinfo in spec.cache.url is accepted',
    file: `${CTRL}redis_acl_reconcile.go`,
    from: 'if redisURLHasUserinfo(app.Spec.Cache.URL) {',
    to: 'if false {',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsRefusals',
  },
  {
    name: 'a reserved platform prefix is accepted at reconcile',
    file: `${CTRL}redis_acl_reconcile.go`,
    from: 'if prefix == "knext" || strings.HasPrefix(prefix, "knext:") {',
    to: 'if false {',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsRefusals',
    optional: true,
  },
  {
    name: 'REDIS_URL is not bound to the operator-owned Secret',
    file: `${CTRL}redis_acl_reconcile.go`,
    from: '\tm["REDIS_URL"] = appsv1alpha1.EnvMapEntry{SecretName: st.secretName, SecretKey: redisCredentialsSecretKey}\n',
    to: '',
    pkg: './internal/controller',
    test: 'TestInjectCacheCredentialsEnvWinsOverTheSharedURL',
  },
  {
    name: 'the finalizer leaves the ACL user behind',
    file: `${CTRL}redis_acl_reconcile.go`,
    from: 'return prov.DelUser(ctx, redisACLUsername(identity, app))',
    to: 'return nil',
    pkg: './internal/controller',
    test: 'TestFinalizerSweepsAsTheAppUserThenDeletesIt',
  },
  {
    name: 'a re-assert rotates the password',
    file: `${CTRL}redis_acl_reconcile.go`,
    from: '\tif password == "" {\n\t\tpw, err := newRedisPassword()',
    to: '\tif true {\n\t\tpw, err := newRedisPassword()',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsReassertKeepsThePassword',
  },
  {
    name: 'admission accepts the platform keyspace as a prefix',
    file: 'internal/validation/validate.go',
    from: 'if p := spec.Cache.KeyPrefix; p == "knext" || strings.HasPrefix(p, "knext:") {',
    to: 'if p := spec.Cache.KeyPrefix; false && p == "knext" {',
    pkg: './internal/validation',
    test: 'TestValidateCacheKeyPrefixReservedPlatformKeyspace',
  },
  {
    name: 'admission accepts an unknown isolation mode',
    file: 'internal/validation/validate.go',
    from: 'case "", "auto", "acl", "none":\n\t\tdefault:',
    to: 'default:\n\t\tcase "", "auto", "acl", "none":',
    pkg: './internal/validation',
    test: 'TestValidateCacheIsolationEnum',
    optional: true,
  },
];

function goTest(pkg, test) {
  const r = spawnSync('go', ['test', pkg, '-run', `^${test}$`, '-count=1'], {
    cwd: OP,
    encoding: 'utf8',
  });
  return r.status;
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

let survived = 0;
let infra = 0;
for (const c of cases) {
  const path = join(OP, c.file);
  const original = readFileSync(path, 'utf8');
  const n = occurrences(original, c.from);
  if (n !== 1) {
    if (c.optional) {
      console.log(`SKIP    ${c.name} (anchor occurs ${n} times; optional)`);
      continue;
    }
    console.error(`ABORT   ${c.name}: anchor occurs ${n} times in ${c.file}, need exactly 1`);
    infra++;
    continue;
  }
  const base = goTest(c.pkg, c.test);
  if (base !== 0) {
    console.error(`ABORT   ${c.name}: baseline ${c.test} is red (exit ${base})`);
    infra++;
    continue;
  }
  try {
    writeFileSync(path, original.replace(c.from, c.to));
    const status = goTest(c.pkg, c.test);
    if (status === 0) {
      console.error(`SURVIVED ${c.name}: ${c.test} stayed green`);
      survived++;
    } else if (status === 1) {
      console.log(`CAUGHT  ${c.name} (${c.test})`);
    } else {
      console.error(`ABORT   ${c.name}: go test exit ${status} (build error, not a test failure)`);
      infra++;
    }
  } finally {
    writeFileSync(path, original);
  }
}
process.exit(infra ? 2 : survived ? 1 : 0);
