/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"errors"
	"strings"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ADR-0071 condition 4, decided from SERVER STATE per endpoint.
//
// "No isolation claim before the shared path is observed refused" cannot be
// settled by two probes. A no-credential connect and `AUTH default` with an
// unissued password are both refused under `requirepass`, yet the real shared
// password still holds `~*`. So the claim is made only when the endpoint itself
// says nothing that reaches an app's keys or runs an admin or dangerous command,
// apart from the provisioner. A knext-app-* user is scoped by its key pattern
// (it is not counted for keys), but it is held to the command rule like every
// other user, its own included.

func assertNoIsolationClaim(t *testing.T, st cacheCredentialsState, why string) {
	t.Helper()
	if st.reason != ReasonCacheSharedCredentialLive {
		t.Fatalf("%s: reason=%q message=%q, want %q", why, st.reason, st.message, ReasonCacheSharedCredentialLive)
	}
	if !strings.Contains(st.message, "isolation not in force: shared credential live") {
		t.Fatalf("%s: message %q lacks the required wording", why, st.message)
	}
	if strings.Contains(strings.ToLower(st.message), "isolated") || strings.Contains(strings.ToLower(st.message), "refuses the shared") {
		t.Fatalf("%s: message claims isolation: %q", why, st.message)
	}
	if !st.ready {
		t.Fatalf("%s: the app has its own user; only the claim is withheld: %+v", why, st)
	}
}

// requirepass: `default` is on with ~* and a password. Both ADR probes are
// refused (NOAUTH, WRONGPASS), so a probe-only operator reports Provisioned.
func TestIsolationClaimRequirepassEndpointIsNotIsolated(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.defaultOn = true
	h.prov.sharedLive = false // both probes refused
	st, err := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if err != nil {
		t.Fatal(err)
	}
	assertNoIsolationClaim(t, st, "requirepass")
	if !strings.Contains(st.message, "default") {
		t.Fatalf("the message should name the live user: %q", st.message)
	}
}

func TestIsolationClaimNamedSharedUser(t *testing.T) {
	cases := []struct {
		name     string
		on       bool
		patterns []string
		live     bool
	}{
		{"on with every key", true, []string{"~*"}, true},
		{"on with the app's own prefix (a hand-made user)", true, []string{"~shop-web:*"}, true},
		{"on with a glob that reaches the app's keys", true, []string{"~shop-*"}, true},
		{"on with a read selector over the app's keys", true, []string{"%R~shop-web:*"}, true},
		{"on with an unrelated prefix", true, []string{"~billing:*"}, false},
		{"on with a key that cannot be an app's", true, []string{"~session:42"}, false},
		{"off with every key", false, []string{"~*"}, false},
		{"on with no keys", true, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newACLHarness(t, true)
			h.prov.addUser("shared", tc.on, tc.patterns...)
			st, err := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
			if err != nil {
				t.Fatal(err)
			}
			if tc.live {
				assertNoIsolationClaim(t, st, tc.name)
				if !strings.Contains(st.message, "shared") {
					t.Fatalf("the message should name the user: %q", st.message)
				}
				return
			}
			if st.reason != ReasonCacheProvisioned {
				t.Fatalf("a user that cannot reach an app's keys must not hold the claim back: %+v", st)
			}
		})
	}
}

// A user with no key pattern can still reach every app's data or take the server
// over. What counts as dangerous is the SERVER's answer (ACL CAT admin and ACL CAT
// dangerous), not a list written here: FLUSHALL, SWAPDB, CONFIG GET, SLOWLOG,
// SHUTDOWN, REPLICAOF and the rest are all in it. The rules are applied left to
// right, and a command is allowed by its own name, by its parent, or by any
// category it belongs to.
func TestCommandCatalogFirstAllowed(t *testing.T) {
	cat, err := newCommandCatalogFrom(fixtureCategory)
	if err != nil {
		t.Fatal(err)
	}
	danger := map[string]string{
		// each is named by the first dangerous command it allows
		"-@all +psync":             "psync",
		"-@all +sync":              "sync",
		"-@all +monitor":           "monitor",
		"-@all +debug":             "debug",
		"-@all +debug|sleep":       "debug",
		"-@all +module":            "module|list",
		"-@all +module|load":       "module|load",
		"-@all +acl":               "acl|deluser",
		"-@all +acl|setuser":       "acl|setuser",
		"-@all +acl|load":          "acl|load",
		"-@all +acl|deluser":       "acl|deluser",
		"-@all +config":            "config|get",
		"-@all +config|get":        "config|get",
		"-@all +config|set":        "config|set",
		"-@all +flushall":          "flushall",
		"-@all +flushdb":           "flushdb",
		"-@all +swapdb":            "swapdb",
		"-@all +replicaof":         "replicaof",
		"-@all +slaveof":           "slaveof",
		"-@all +failover":          "failover",
		"-@all +shutdown":          "shutdown",
		"-@all +slowlog":           "slowlog|get",
		"-@all +slowlog|get":       "slowlog|get",
		"-@all +keys":              "keys",
		"-@all +info":              "info",
		"+@all -@dangerous +psync": "psync",
		"-@ALL +PSYNC":             "psync",
		// a command is allowed by any category that holds it
		"-@all +@write":      "flushall",
		"-@all +@keyspace":   "flushall",
		"-@all +@read":       "keys",
		"-@all +@connection": "client|kill",
		"-@all +@fast":       "swapdb",
		// and the broad ones
		"+@all":         "",
		"allcommands":   "",
		"+@admin":       "",
		"+@dangerous":   "",
		"+@slow":        "",
		"-@all +@admin": "",
		// denying a few of many leaves the rest
		"+@all -psync -sync -monitor -debug -module -acl -config": "",
		"+@all -@admin": "", // admin is a subset of dangerous: flushall, keys, info remain
	}
	for rules, want := range danger {
		got, ok, err := cat.firstAllowed(rules)
		if err != nil {
			t.Fatalf("%q: %v", rules, err)
		}
		if !ok || (want != "" && got != want) {
			t.Errorf("firstAllowed(%q) = %q, %v; want %q", rules, got, ok, want)
		}
	}

	safe := []string{
		"",
		"nocommands",
		"-@all",
		"-@all +get +set +ping",
		"+@all -@all +ping",
		"+@all -@dangerous",
		"+@all -@dangerous -@admin",
		"+@all -@dangerous +get",
		"-@all +client|setinfo +acl|whoami +acl|cat +ping +time",
		// later rules win
		"-@all +psync -psync",
		"+@all -@dangerous +@read -keys -sort_ro",
	}
	for _, rules := range safe {
		got, ok, err := cat.firstAllowed(rules)
		if err != nil {
			t.Fatalf("%q: %v", rules, err)
		}
		if ok {
			t.Errorf("firstAllowed(%q) = %q; want none", rules, got)
		}
	}
}

// The catalog is the server's: when ACL CAT is refused nothing can be said, and
// nothing is claimed.
func TestCommandCatalogFailsClosedWhenACLCATIsRefused(t *testing.T) {
	if _, err := newCommandCatalogFrom(failingCategory); err == nil {
		t.Fatal("a refused ACL CAT was read as an empty dangerous set")
	}
	// an empty answer for admin or dangerous is as unusable as an error
	if _, err := newCommandCatalogFrom(func(string) ([]string, error) { return nil, nil }); err == nil {
		t.Fatal("an empty dangerous set was accepted")
	}
	// Any other category is read when a rule mentions it; a refusal there is an
	// error too, never an empty category.
	partial := func(category string) ([]string, error) {
		if category == "read" {
			return failingCategory(category)
		}
		return fixtureCategory(category)
	}
	cat, err := newCommandCatalogFrom(partial)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := cat.firstAllowed("-@all +@read"); err == nil {
		t.Fatal("a refused category lookup was read as an empty category")
	}
	if _, _, err := cat.firstAllowed("-@all +ping"); err != nil {
		t.Fatalf("a rule that mentions no category must not need one: %v", err)
	}
}

func TestIsolationClaimSeesAUserThatCanRunDangerousCommandsWithoutKeys(t *testing.T) {
	cases := []struct {
		name  string
		on    bool
		rules []string
		live  bool
		why   string
	}{
		{"psync and no keys", true, []string{"-@all +psync"}, true, "psync"},
		{"acl setuser and no keys", true, []string{"-@all +acl|setuser"}, true, "acl|setuser"},
		{"flushall and no keys", true, []string{"-@all +flushall"}, true, "flushall"},
		{"config get and no keys", true, []string{"-@all +config|get"}, true, "config|get"},
		{"swapdb and no keys", true, []string{"-@all +swapdb"}, true, "swapdb"},
		{"slowlog and no keys", true, []string{"-@all +slowlog|get"}, true, "slowlog|get"},
		{"everything but a few", true, []string{"+@all -psync -sync -monitor -debug -module -acl -config"}, true, ""},
		{"a dangerous selector", true, []string{"-@all +ping", "+@all"}, true, ""},
		{"everything", true, []string{"+@all"}, true, ""},
		{"harmless commands", true, []string{"-@all +ping +get"}, false, ""},
		{"disabled with everything", false, []string{"+@all"}, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newACLHarness(t, true)
			h.prov.addUser("replicator", tc.on) // no key patterns at all
			h.prov.setCommands("replicator", tc.rules...)
			st, err := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
			if err != nil {
				t.Fatal(err)
			}
			if tc.live {
				assertNoIsolationClaim(t, st, tc.name)
				if !strings.Contains(st.message, "replicator") || !strings.Contains(st.message, tc.why) {
					t.Fatalf("the message should name the user and the command: %q", st.message)
				}
				return
			}
			if st.reason != ReasonCacheProvisioned {
				t.Fatalf("%+v", st)
			}
		})
	}
}

// ACL CAT refused: no claim.
func TestIsolationClaimNeedsTheServersCommandCategories(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.catErr = errors.New("NOPERM this user has no permissions to run the 'acl|cat' command")
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	assertNoIsolationClaim(t, st, "ACL CAT refused")
}

// Another app's own user is held to the same rule: a user named knext-app-* that
// can run FLUSHALL is a shared credential whatever its name says.
func TestIsolationClaimChecksCommandsOfEveryUserButTheProvisioner(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.addUser("knext-app-deadbeef-aaaaaaaaaaaa", true, "~other:*")
	h.prov.setCommands("knext-app-deadbeef-aaaaaaaaaaaa", "-@all +get +flushall")
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	assertNoIsolationClaim(t, st, "a knext-app-* user with FLUSHALL")
	if !strings.Contains(st.message, "knext-app-deadbeef-aaaaaaaaaaaa") {
		t.Fatalf("the message should name the user: %q", st.message)
	}

	// An ordinary app user, with the rules the operator grants, holds nothing back.
	h2 := newACLHarness(t, true)
	h2.prov.addUser("knext-app-deadbeef-bbbbbbbbbbbb", true, "~other:*")
	h2.prov.setCommands("knext-app-deadbeef-bbbbbbbbbbbb", "-@all "+strings.Join(prefixedPlus(appRedisCommands()), " "))
	if st, _ := h2.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h2.snap); st.reason != ReasonCacheProvisioned {
		t.Fatalf("an app user with the operator's own rules must not hold the claim back: %+v", st)
	}
}

func prefixedPlus(cmds []string) []string {
	out := make([]string, len(cmds))
	for i, c := range cmds {
		out[i] = "+" + c
	}
	return out
}

// The operator's own grant is not dangerous, or every app on the endpoint would
// hold the claim back for every other. Pinned against the server's categories.
func TestTheOperatorsOwnCommandListIsNotDangerous(t *testing.T) {
	cat, err := newCommandCatalogFrom(fixtureCategory)
	if err != nil {
		t.Fatal(err)
	}
	rules := "-@all " + strings.Join(prefixedPlus(appRedisCommands()), " ")
	if got, ok, err := cat.firstAllowed(rules); err != nil || ok {
		t.Fatalf("appRedisCommands() allows %q (%v): every isolated app would hold the claim back", got, err)
	}
}

// A knext-app-* user with a foreign key pattern and no command rules is not a
// key-pattern leak: the provisioner is skipped, and knext-app-* users are not
// counted for their key patterns. Their command rules are still checked (see
// TestIsolationClaimChecksCommandsOfEveryUserButTheProvisioner).
func TestIsolationClaimIgnoresTheProvisionerAndKnextAppKeyPatterns(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.addUser("knext-app-deadbeef-aaaaaaaaaaaa", true, "~other:*")
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if st.reason != ReasonCacheProvisioned {
		t.Fatalf("the provisioner (on, ~*) and knext-app-* users are not a shared credential: %+v", st)
	}
}

// The provisioner IS the default user: the credential the operator dials with is
// the shared one, so nothing is isolated.
func TestIsolationClaimProvisionerThatIsTheDefaultUser(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.provUser = "default"
	h.prov.defaultOn = true
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	assertNoIsolationClaim(t, st, "provisioner is default")
}

// A failed server-state read is not a refusal: no claim.
func TestIsolationClaimFailedCheckIsNotAClaim(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.getUserErr = errors.New("NOPERM this user has no permissions to run the 'acl|getuser' command")
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	assertNoIsolationClaim(t, st, "GETUSER refused")
}

func (h *aclHarness) createSibling(t *testing.T, app *appsv1alpha1.NextApp) {
	t.Helper()
	if err := h.c.Create(context.Background(), app); err != nil {
		t.Fatal(err)
	}
}

// An app on the same endpoint with isolation: none keeps a working credential, so
// the endpoint is not isolated, however the server's users look.
func TestIsolationClaimSameEndpointNoneAppKeepsACredential(t *testing.T) {
	h := newACLHarness(t, true)
	h.createSibling(t, aclApp("legacy", "api", "legacy-api", cacheIsolationNone))
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	assertNoIsolationClaim(t, st, "an isolation: none sibling")
	if !strings.Contains(st.message, "legacy/api") {
		t.Fatalf("the message should name the app: %q", st.message)
	}

	// The same sibling on ANOTHER endpoint does not matter.
	h2 := newACLHarness(t, true)
	other := aclApp("legacy", "api", "legacy-api", cacheIsolationNone)
	other.Spec.Cache.URL = "redis://other.cache.svc.cluster.local:6379"
	h2.createSibling(t, other)
	if st, _ := h2.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h2.snap); st.reason != ReasonCacheProvisioned {
		t.Fatalf("a none app on another endpoint must not hold the claim back: %+v", st)
	}
}

// A same-endpoint app that carries a credential in its spec (userinfo in the URL,
// or its own REDIS_URL) holds a working shared credential too, though it fails
// closed itself.
func TestIsolationClaimSameEndpointAppCarryingACredentialInItsSpec(t *testing.T) {
	withUserinfo := aclApp("legacy", "api", "legacy-api", "")
	withUserinfo.Spec.Cache.URL = "redis://u:p@redis.cache.svc.cluster.local:6379"
	withEnvMap := aclApp("legacy", "worker", "legacy-worker", "")
	withEnvMap.Spec.Secrets = &appsv1alpha1.SecretsSpec{EnvMap: map[string]appsv1alpha1.EnvMapEntry{"REDIS_URL": {SecretName: "mine", SecretKey: "k"}}}
	for name, sibling := range map[string]*appsv1alpha1.NextApp{"userinfo": withUserinfo, "envMap REDIS_URL": withEnvMap} {
		t.Run(name, func(t *testing.T) {
			h := newACLHarness(t, true)
			h.createSibling(t, sibling)
			st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
			assertNoIsolationClaim(t, st, name)
		})
	}
}

// The claim is per ENDPOINT and survives re-evaluation: once every shared path is
// gone it is made, and a later shared user takes it back on the next pass.
func TestIsolationClaimIsMadeAndWithdrawnFromServerState(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st, _ := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	if st.reason != ReasonCacheProvisioned {
		t.Fatalf("clean endpoint: %+v", st)
	}
	h.prov.defaultOn = true // an admin re-enables the shared credential
	st, _ = h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	assertNoIsolationClaim(t, st, "default re-enabled")
}
