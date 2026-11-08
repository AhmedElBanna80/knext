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
 *   ONLY='B3:' node scripts/mutation-prove-2396-redis-acl.mjs   # cases whose name contains it
 *
 * Exit 0: every mutation was caught. Exit 1: a mutation survived (a guard is
 * decoration). Exit 2: infrastructure (an anchor missing or ambiguous, or the
 * baseline red).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OP = join(REPO, 'packages/kn-next-operator');

// Each case names its subject file as a repo-relative literal, so the anchor-drift
// scans (scripts/lib/prover-anchor-scan.mjs, tests/mutation-prover-lane.test.ts)
// can check every anchor against it without running Go.
const cases = [
  {
    name: 'operator drops "time" from the command list',
    file: 'packages/kn-next-operator/internal/controller/redis_acl.go',
    anchor: '"hget", "hset", "hdel", "hmget", "hscan", "scan", "eval", "time",',
    to: '"hget", "hset", "hdel", "hmget", "hscan", "scan", "eval",',
    pkg: './internal/controller',
    test: 'TestAppRedisCommandsMatchTheSpike',
  },
  {
    name: 'operator grants INFO',
    file: 'packages/kn-next-operator/internal/controller/redis_acl.go',
    anchor: '"client|setinfo",\n\t}',
    to: '"client|setinfo", "info",\n\t}',
    pkg: './internal/controller',
    test: 'TestRedisACLRulesShape',
  },
  {
    name: 'rules lose the deny-all',
    file: 'packages/kn-next-operator/internal/controller/redis_acl.go',
    anchor: 'rules = append(rules, "resetchannels", "-@all")',
    to: 'rules = append(rules, "resetchannels")',
    pkg: './internal/controller',
    test: 'TestRedisACLRulesShape',
  },
  {
    name: 'key pattern is not glob-escaped',
    file: 'packages/kn-next-operator/internal/controller/redis_acl.go',
    anchor: 'func redisGlobEscape(text string) string { return escapeRedisGlob(text) }',
    to: 'func redisGlobEscape(text string) string { return text }',
    pkg: './internal/controller',
    test: 'TestRedisACLRulesEscapeThePrefixGlob',
  },
  {
    name: 'acl on an unregistered endpoint falls back to the shared credential',
    file: 'packages/kn-next-operator/internal/controller/redis_acl.go',
    anchor: '\t\treturn isolationRequiredUnavailable\n',
    to: '\t\treturn isolationShared\n',
    pkg: './internal/controller',
    test: 'TestResolveCacheIsolation',
  },
  {
    name: 'only an exactly equal prefix conflicts',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'return a == b || strings.HasPrefix(a, b+":") || strings.HasPrefix(b, a+":")',
    to: 'return a == b',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsOverlappingUserOnTheEndpointConflicts',
  },
  {
    name: 'a pattern the operator cannot parse is treated as no conflict',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'if !ok || prefixesOverlap(prefix, other) {',
    to: 'if ok && prefixesOverlap(prefix, other) {',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsUnparseablePatternFailsClosed',
  },
  {
    name: 'a live shared credential is reported as isolated',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'if live, detail := sharedPathLive(ctx, prov, apps, app); live {',
    to: 'if live, detail := sharedPathLive(ctx, prov, apps, app); live && false {',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsSharedCredentialLiveIsNotAnIsolationClaim',
  },
  {
    name: 'userinfo in spec.cache.url is accepted',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_ownership.go',
    anchor: 'if redisURLHasUserinfo(app.Spec.Cache.URL) {',
    to: 'if false {',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsRefusals',
  },
  {
    name: 'a reserved platform prefix is accepted (reconcile and admission share the rule)',
    file: 'packages/kn-next-operator/internal/validation/cache_prefix.go',
    anchor: '\tif IsPlatformKeyspace(prefix) {\n\t\treturn fmt.Sprintf',
    to: '\tif false {\n\t\treturn fmt.Sprintf',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsRefusals',
  },
  {
    name: 'REDIS_URL is not bound to the operator-owned Secret',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor:
      '\tm["REDIS_URL"] = appsv1alpha1.EnvMapEntry{SecretName: st.secretName, SecretKey: redisCredentialsSecretKey}\n',
    to: '',
    pkg: './internal/controller',
    test: 'TestInjectCacheCredentialsEnvWinsOverTheSharedURL',
  },
  {
    name: 'the finalizer leaves the ACL user behind',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\t\treturn prov.DelUser(ctx, username)\n',
    to: '\t\treturn nil\n',
    pkg: './internal/controller',
    test: 'TestFinalizerSweepsAsTheAppUserThenDeletesIt',
  },
  {
    name: 'a re-assert rotates the password',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\tif password == "" {\n\t\tpw, err := newRedisPassword()',
    to: '\tif true {\n\t\tpw, err := newRedisPassword()',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsReassertKeepsThePassword',
  },
  {
    name: 'admission accepts the platform keyspace as a prefix',
    file: 'packages/kn-next-operator/internal/validation/validate.go',
    anchor: 'if p := spec.Cache.KeyPrefix; IsPlatformKeyspace(p) {',
    to: 'if p := spec.Cache.KeyPrefix; false && IsPlatformKeyspace(p) {',
    pkg: './internal/validation',
    test: 'TestValidateCacheKeyPrefixReservedPlatformKeyspace',
  },
  {
    name: 'admission accepts an unknown isolation mode',
    file: 'packages/kn-next-operator/internal/validation/validate.go',
    anchor: '\t\tcase "", "auto", "acl", "none":\n\t\tdefault:\n',
    to: '\t\tdefault:\n',
    pkg: './internal/validation',
    test: 'TestValidateCacheIsolationEnum',
  },

  // ── Review of PR #2818 (design review 2026-11-08) ─────────────────────────

  // B1: isolation is claimed from the endpoint's own state, never from the two
  // probes alone (requirepass refuses both while the shared password holds ~*).
  {
    name: 'B1: the server-state scan is skipped (probes alone decide)',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\t\t\t\tif patternMayCoverPrefix(p, prefix) {',
    to: '\t\t\t\tif false && patternMayCoverPrefix(p, prefix) {',
    pkg: './internal/controller',
    test: 'TestIsolationClaimRequirepassEndpointIsNotIsolated',
  },
  {
    name: 'B1: a disabled user counts as live (and an enabled one does not)',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\t\tif !info.Enabled {\n\t\t\tcontinue\n\t\t}',
    to: '\t\tif info.Enabled {\n\t\t\tcontinue\n\t\t}',
    pkg: './internal/controller',
    test: 'TestIsolationClaimNamedSharedUser',
  },
  {
    name: 'B1: knext-app-* users are counted as a shared credential',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'if u == provisioner || strings.HasPrefix(u, redisACLUsernamePrefix) {',
    to: 'if u == provisioner {',
    pkg: './internal/controller',
    test: 'TestIsolationClaimIgnoresTheProvisionerAndKnextAppUsers',
  },
  {
    name: 'B1: a provisioner that is the default user still earns the claim',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'if provisioner == "" || provisioner == "default" {',
    to: 'if false {',
    pkg: './internal/controller',
    test: 'TestIsolationClaimProvisionerThatIsTheDefaultUser',
  },
  {
    name: 'B1: a failed GETUSER is read as "nothing live"',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor:
      '\t\tinfo, err := prov.GetUser(ctx, u)\n\t\tif err != nil {\n\t\t\treturn true, "the check failed: " + redactErr(err)\n\t\t}',
    to: '\t\tinfo, err := prov.GetUser(ctx, u)\n\t\tif err != nil {\n\t\t\tcontinue\n\t\t}',
    pkg: './internal/controller',
    test: 'TestIsolationClaimFailedCheckIsNotAClaim',
  },
  {
    name: 'B1: an isolation: none sibling on the endpoint is ignored',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'if a != self && holdsSharedCredential(a) {',
    to: 'if false && a != self && holdsSharedCredential(a) {',
    pkg: './internal/controller',
    test: 'TestIsolationClaimSameEndpointNoneAppKeepsACredential',
  },
  {
    name: 'B1: a glob key pattern is judged as if it could not reach the app',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\t\treturn strings.HasPrefix(target, h) || strings.HasPrefix(h, target)\n',
    to: '\t\treturn false\n',
    pkg: './internal/controller',
    test: 'TestPatternMayCoverPrefix',
  },
  {
    name: 'B1: selectors are not read from ACL GETUSER',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\tif sels, ok := fields["selectors"].([]any); ok {',
    to: '\tif sels, ok := fields["selectors"].([]any); ok && false {',
    pkg: './internal/controller',
    test: 'TestParseACLGetUser',
  },

  // B2: the nested derived-prefix squat, at reconcile and at admission.
  {
    name: 'B2: only the exact derived shape is reserved (a nesting slips through)',
    file: 'packages/kn-next-operator/internal/validation/cache_prefix.go',
    anchor: '`(?s)^kn-[0-9a-f]{12}(:.*)?$`',
    to: '`(?s)^kn-[0-9a-f]{12}$`',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsRefusals',
  },
  {
    name: 'B2: the same, as admission sees it',
    file: 'packages/kn-next-operator/internal/validation/cache_prefix.go',
    anchor: '`(?s)^kn-[0-9a-f]{12}(:.*)?$`',
    to: '`(?s)^kn-[0-9a-f]{12}$`',
    pkg: './internal/webhook/v1alpha1',
    test: 'TestAdmissionRefusesTheDerivedPrefixShapeThatIsNotTheAppsOwn',
  },
  {
    name: "B2: the app's own nesting is allowed (only the exact own prefix may be)",
    file: 'packages/kn-next-operator/internal/validation/cache_prefix.go',
    anchor: 'prefix != DerivedCacheKeyPrefix(namespace, name) {',
    to: '!strings.HasPrefix(prefix, DerivedCacheKeyPrefix(namespace, name)) {',
    pkg: './internal/validation',
    test: 'TestCacheKeyPrefixViolation',
  },
  {
    name: 'B2: the webhook does not apply the rule on CREATE',
    file: 'packages/kn-next-operator/internal/webhook/v1alpha1/nextapp_webhook.go',
    anchor:
      '\treturn nil, validation.ValidateNextAppCacheKeyPrefix(nextApp.GetNamespace(), nextApp.GetName(), &nextApp.Spec)',
    to: '\treturn nil, nil',
    pkg: './internal/webhook/v1alpha1',
    test: 'TestAdmissionRefusesTheDerivedPrefixShapeThatIsNotTheAppsOwn',
  },
  {
    name: 'B2: the webhook does not apply the rule on UPDATE',
    file: 'packages/kn-next-operator/internal/webhook/v1alpha1/nextapp_webhook.go',
    anchor:
      '\treturn nil, validation.ValidateNextAppCacheKeyPrefix(newApp.GetNamespace(), newApp.GetName(), &newApp.Spec)',
    to: '\treturn nil, nil',
    pkg: './internal/webhook/v1alpha1',
    test: 'TestAdmissionRefusesTheDerivedPrefixShapeThatIsNotTheAppsOwn',
  },
  {
    name: 'B2: the reconciler does not apply the shared rule',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\treturn validation.CacheKeyPrefixViolation(app.Namespace, app.Name, prefix)',
    to: '\treturn ""',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsRefusals',
  },
  {
    name: 'B2: a refused squat keeps its earlier user',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\t\t\tmsg += r.revokeAfterRefusal(ctx, app, snap, ep)\n',
    to: '',
    pkg: './internal/controller',
    test: 'TestCacheCredentialsReservedPrefixRevokesAnEarlierUser',
  },
  {
    name: "B2: deleting a squatting CR sweeps the owner's keyspace",
    file: 'packages/kn-next-operator/internal/controller/finalizer.go',
    anchor: '\tif why := reservedCachePrefix(app, keyPrefix); why != "" {',
    to: '\tif why := reservedCachePrefix(app, keyPrefix); why != "" && false {',
    pkg: './internal/controller',
    test: 'TestFinalizerNeverSweepsAReservedPrefixOnThePlainPath',
  },

  // B3: ownership by rule, never by arrival.
  {
    name: 'B3: the younger app outranks the older',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_ownership.go',
    anchor: '\t\treturn a.created < b.created\n',
    to: '\t\treturn a.created > b.created\n',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipOlderWinsWhenTheYoungerWasProvisionedFirst',
  },
  {
    name: 'B3: the derived owner does not outrank an older app',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_ownership.go',
    anchor: '\t\treturn a.derived\n',
    to: '\t\treturn b.derived\n',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipTiebreakOrder',
  },
  {
    name: 'B3: the larger uid wins the tiebreak',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_ownership.go',
    anchor: '\t\treturn a.uid < b.uid\n',
    to: '\t\treturn a.uid > b.uid\n',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipTiebreakOrder',
  },
  {
    name: "B3: creationTimestamp is compared below the API's one-second resolution",
    file: 'packages/kn-next-operator/internal/controller/redis_acl_ownership.go',
    anchor: 'created:  app.CreationTimestamp.Unix(),',
    to: 'created:  app.CreationTimestamp.UnixNano(),',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipTiebreakOrder',
  },
  {
    name: 'B3: the ownership check is skipped (first arrival keeps the prefix)',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'if blocker := prefixBlocker(claims, self.ref); blocker != nil {',
    to: 'if blocker := prefixBlocker(claims, self.ref); blocker != nil && false {',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipOlderKeepsItWhenTheYoungerArrivesSecond',
  },
  {
    name: 'B3: a loser keeps its user until the owner evicts it',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'conflictMessage(prefix, *blocker, self)+revokeUser(ctx, prov, st.username))',
    to: 'conflictMessage(prefix, *blocker, self))',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipLoserRevokesItsOwnUserBeforeTheOwnerRuns',
  },
  {
    name: "B3: the owner does not evict a visible loser's user",
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor:
      '\t\tif c.ref == self.ref || !present[c.username] || !prefixesOverlap(self.prefix, c.prefix) {',
    to: '\t\tif true {',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipOlderWinsWhenTheYoungerWasProvisionedFirst',
  },
  {
    name: 'B3: the claim is not re-checked after the write (a concurrent claim leaves two users)',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\tconflict, err = claimPrefix(ctx, prov, self, claims)\n',
    to: '\tconflict, err = "", nil\n',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipConcurrentClaimAnUnseenUserLandsBetweenCheckAndWrite',
  },
  {
    name: 'B3: apps on other endpoints count as claimants',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_ownership.go',
    anchor: 'err != nil || c != canonical {',
    to: 'err != nil {',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipIgnoresAppsThatCannotHoldAUser',
  },
  {
    name: 'B3: an isolation: none app holds a prefix against a valid one',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_ownership.go',
    anchor:
      '\t\tif a.Spec.Cache.Isolation == cacheIsolationNone {\n\t\t\tcontinue\n\t\t}\n\t\tif reason',
    to: '\t\tif reason',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipIgnoresAppsThatCannotHoldAUser',
  },
  {
    name: 'B3: a refused app holds a prefix against a valid one',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_ownership.go',
    anchor: '\t\tif reason, _ := cacheLocalRefusal(a); reason != "" {',
    to: '\t\tif reason, _ := cacheLocalRefusal(a); reason != "" && false {',
    pkg: './internal/controller',
    test: 'TestPrefixOwnershipIgnoresAppsThatCannotHoldAUser',
  },
  {
    name: "B3: a losing app's deletion sweeps the owner's keys",
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\treturn prefixBlocker(claims, self.ref) == nil, nil\n',
    to: '\treturn true, nil\n',
    pkg: './internal/controller',
    test: 'TestFinalizerOfALosingAppNeverSweepsTheOwnersKeys',
  },

  // M1: the verdict owns the condition and the requeue.
  {
    name: 'M1: a transient failure is not retried by the verdict',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor:
      '\tcase ReasonCacheProvisionerRefused, ReasonCacheAclUnsupported, ReasonCachePrefixConflict:\n',
    to: '\tcase ReasonCacheAclUnsupported, ReasonCachePrefixConflict:\n',
    pkg: './internal/controller',
    test: 'TestVerdictRequeuesTheCacheCredentialsStep',
  },
  {
    name: 'M1: a failed step aborts the pass before the verdict (stale Provisioned stays)',
    file: 'packages/kn-next-operator/internal/controller/nextapp_controller.go',
    anchor: '\t\tcacheCreds = transientCacheCredentials(&nextApp, cacheErr)\n',
    to: '\t\treturn ctrl.Result{}, cacheErr\n',
    pkg: './internal/controller',
    test: 'TestControllers',
    focus: 'cache-credentials step',
    envtest: true,
  },

  // M2: the finalizer decides from the Secret and the registration.
  {
    name: 'M2: the lost user is not re-asserted before the sweep',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor:
      '\t\t\tif err := reassertForCleanup(ctx, prov, app, keyPrefix, username, appURL); err != nil {',
    to: '\t\t\tif err := error(nil); err != nil {',
    pkg: './internal/controller',
    test: 'TestFinalizerReassertsALostUserBeforeTheSweep',
  },
  {
    name: 'M2: a deregistered endpoint skips the sweep and says nothing',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor:
      '\tcase !registered:\n\t\treturn fmt.Errorf("the Redis endpoint is no longer registered, so the ACL user %q was left on it", username)',
    to: '\tcase !registered:\n\t\treturn nil',
    pkg: './internal/controller',
    test: 'TestFinalizerOnADeregisteredEndpointSweepsAndNamesTheLeftoverUser',
  },
  {
    name: 'M2: the finalizer only cleans up an app whose status says acl',
    file: 'packages/kn-next-operator/internal/controller/finalizer.go',
    anchor: '\t\tcleanErr := r.cleanupIsolatedCache(ctx, app, keyPrefix)\n',
    to: '\t\tvar cleanErr error = errNoCredentialsSecret\n\t\tif app.Status.Cache != nil {\n\t\t\tcleanErr = r.cleanupIsolatedCache(ctx, app, keyPrefix)\n\t\t}\n',
    pkg: './internal/controller',
    test: 'TestFinalizerDecidesFromTheSecretNotFromStatus',
  },

  // M3: the provisioner is endpoint-bound.
  {
    name: "M3: the Secret's own host is dialled",
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: '\tu.Host = ep.Endpoint\n',
    to: '',
    pkg: './internal/controller',
    test: 'TestProvisionerIsDialledAtTheRegisteredEndpointNotTheSecretsSpelling',
  },
  {
    name: 'M3: a Secret that points elsewhere is followed',
    file: 'packages/kn-next-operator/internal/controller/redis_acl_reconcile.go',
    anchor: 'err != nil || canonical != ep.Endpoint {',
    to: 'err != nil {',
    pkg: './internal/controller',
    test: 'TestProvisionerIsPinnedToTheRegisteredEndpoint',
  },
];

// KUBEBUILDER_ASSETS for the envtest cases; the shared checkout carries the binaries.
const ENVTEST_ASSETS =
  process.env.KUBEBUILDER_ASSETS ??
  '/Users/banna/alpheya/pocs/knext/packages/kn-next-operator/bin/k8s/1.35.0-darwin-arm64';

function goTest(pkg, test, c = {}) {
  const args = ['test', pkg, '-run', `^${test}$`, '-count=1'];
  if (c.focus) args.push(`-ginkgo.focus=${c.focus}`);
  const r = spawnSync('go', args, {
    cwd: OP,
    encoding: 'utf8',
    env: c.envtest ? { ...process.env, KUBEBUILDER_ASSETS: ENVTEST_ASSETS } : process.env,
  });
  return r.status;
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

let survived = 0;
let infra = 0;
const selected = cases.filter((c) => !process.env.ONLY || c.name.includes(process.env.ONLY));
declareMutations(selected.length);
for (const c of selected) {
  const path = join(REPO, c.file);
  const original = readFileSync(path, 'utf8');
  const n = occurrences(original, c.anchor);
  if (n !== 1) {
    if (c.optional) {
      console.log(`SKIP    ${c.name} (anchor occurs ${n} times; optional)`);
      continue;
    }
    console.error(`ABORT   ${c.name}: anchor occurs ${n} times in ${c.file}, need exactly 1`);
    infra++;
    continue;
  }
  const base = goTest(c.pkg, c.test, c);
  if (base !== 0) {
    console.error(`ABORT   ${c.name}: baseline ${c.test} is red (exit ${base})`);
    infra++;
    continue;
  }
  try {
    writeFileSync(path, original.replace(c.anchor, c.to));
    const status = goTest(c.pkg, c.test, c);
    if (status === 0) {
      console.error(`SURVIVED ${c.name}: ${c.test} stayed green`);
      survived++;
      recordMutation();
    } else if (status === 1) {
      console.log(`CAUGHT  ${c.name} (${c.test})`);
      recordMutation();
    } else {
      console.error(`ABORT   ${c.name}: go test exit ${status} (build error, not a test failure)`);
      infra++;
    }
  } finally {
    writeFileSync(path, original);
  }
}
process.exit(infra ? 2 : survived ? 1 : 0);
