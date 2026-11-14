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
	"strings"
	"testing"
	"time"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Review r3, B-1: REDIS_KEY_PREFIX in spec.env or spec.secrets.envMap is the legacy
// way to set a prefix. operatorRedisKeyPrefix returns "" for it (the operator
// cannot scope an ACL user to it), but the app still writes under that prefix. An
// app that is not ranked is an app any younger copy can take the prefix from, and
// whose keys the copy's finalizer then sweeps.

func withEnvPrefix(v string) func(*appsv1alpha1.NextApp) {
	return func(a *appsv1alpha1.NextApp) {
		a.Spec.Cache.KeyPrefix = ""
		a.Spec.Env = map[string]string{redisKeyPrefixEnvName: v}
	}
}

// notBlocked: the app was issued its user. (With an isolation: none sibling on the
// endpoint the claim is still withheld, so the reason is not necessarily Provisioned.)
func notBlocked(st cacheCredentialsState) bool {
	return st.ready && !st.failClosed && st.reason != ReasonCachePrefixConflict
}

func withEnvMapPrefix(a *appsv1alpha1.NextApp) {
	a.Spec.Cache.KeyPrefix = ""
	a.Spec.Secrets = &appsv1alpha1.SecretsSpec{EnvMap: map[string]appsv1alpha1.EnvMapEntry{
		redisKeyPrefixEnvName: {SecretName: "prefix-secret", SecretKey: "prefix"},
	}}
}

// rankingPrefix is the prefix an app HOLDS, which is wider than the prefix the
// operator can scope a user to (operatorRedisKeyPrefix).
func TestRankingPrefix(t *testing.T) {
	const (
		derivedPrefix = "<derived>"
		nobodys       = ""
	)
	cases := []struct {
		name       string
		mutate     func(*appsv1alpha1.NextApp)
		want       string
		wantOpaque bool
	}{
		{"an explicit prefix", func(a *appsv1alpha1.NextApp) { a.Spec.Cache.KeyPrefix = "team" }, "team", false},
		{"no prefix set: the derived one", func(a *appsv1alpha1.NextApp) { a.Spec.Cache.KeyPrefix = "" }, derivedPrefix, false},
		{"a literal in spec.env", withEnvPrefix("team"), "team", false},
		{"a nested literal in spec.env", withEnvPrefix("team:sub"), "team:sub", false},
		{"an EMPTY spec.env value is unset: the derived one", withEnvPrefix(""), derivedPrefix, false},
		{"the shared fallback in spec.env is nobody's", withEnvPrefix("kn-next"), nobodys, false},
		{"under the shared fallback in spec.env is nobody's", withEnvPrefix("kn-next:cache"), nobodys, false},
		{"a Secret in envMap is opaque", withEnvMapPrefix, nobodys, true},
		{"a Secret in envMap and a literal in spec.env: which one wins at runtime is unknown", func(a *appsv1alpha1.NextApp) {
			withEnvMapPrefix(a)
			a.Spec.Env = map[string]string{redisKeyPrefixEnvName: "team"}
		}, nobodys, true},
		{"not a Redis cache", func(a *appsv1alpha1.NextApp) {
			a.Spec.Cache.Provider = "memory"
			withEnvMapPrefix(a)
		}, nobodys, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := aclAppAt("legacy", "api", "x", "", tOld)
			tc.mutate(app)
			want := tc.want
			if want == derivedPrefix {
				want = defaultRedisKeyPrefix(app)
			}
			got, opaque := rankingPrefix(app)
			if opaque != tc.wantOpaque || got != want {
				t.Fatalf("rankingPrefix = %q, opaque=%v; want %q, opaque=%v", got, opaque, want, tc.wantOpaque)
			}
		})
	}
}

// A prefix set through spec.env is ranked like an explicit one.
func TestPrefixOwnershipRanksAPrefixSetThroughEnv(t *testing.T) {
	relations := []struct {
		name       string
		held, want string
	}{
		{"equal", "team", "team"},
		{"the younger nests inside the older", "team", "team:sub"},
		{"the younger contains the older", "team:sub", "team"},
	}
	for _, rel := range relations {
		for _, iso := range []string{cacheIsolationNone, ""} {
			t.Run(rel.name+" (older isolation "+iso+")", func(t *testing.T) {
				h := newACLHarness(t, true)
				old := aclAppAt("legacy", "api", "x", iso, tOld)
				withEnvPrefix(rel.held)(old)
				h.createSibling(t, old)
				young := aclAppAt("shop", "web", rel.want, "", tYoung)
				h.createSibling(t, young)

				st := h.reconcileApp(t, young)
				if st.reason != ReasonCachePrefixConflict || !st.failClosed || st.ready {
					t.Fatalf("a younger app took a prefix an older app sets through env: %+v", st)
				}
				if !strings.Contains(st.message, "legacy/api") {
					t.Fatalf("the condition must name the holder: %q", st.message)
				}
				if h.prov.hasUser(h.userOf(young)) || countOps(h.prov.opsLog(), "SETUSER "+h.userOf(young)) != 0 {
					t.Fatal("the younger app was issued a user over the holder's keys")
				}
			})
		}
	}

	t.Run("a younger env-prefix app does not take an older app's prefix", func(t *testing.T) {
		h := newACLHarness(t, true)
		old := aclAppAt("shop", "web", "team", "", tOld)
		young := aclAppAt("legacy", "api", "x", cacheIsolationNone, tYoung)
		withEnvPrefix("team")(young)
		h.createSibling(t, old)
		h.createSibling(t, young)
		if st := h.reconcileApp(t, old); st.reason == ReasonCachePrefixConflict || !st.ready {
			t.Fatalf("the older app must keep its prefix: %+v", st)
		}
	})
}

// A prefix that lives in a Secret cannot be compared. The operator does not read a
// tenant's Secret to find out, so such an app is treated as holding any prefix: it
// blocks every younger claim except one that is derived (the derived shape is
// reserved for its own app, and always outranks).
func TestPrefixOwnershipAnOlderAppWhosePrefixComesFromASecretBlocksYoungerClaims(t *testing.T) {
	for _, iso := range []string{cacheIsolationNone, ""} {
		t.Run("older isolation "+iso, func(t *testing.T) {
			h := newACLHarness(t, true)
			old := aclAppAt("legacy", "api", "x", iso, tOld)
			withEnvMapPrefix(old)
			h.createSibling(t, old)

			young := aclAppAt("shop", "web", "other", "", tYoung)
			h.createSibling(t, young)
			st := h.reconcileApp(t, young)
			if st.reason != ReasonCachePrefixConflict || !st.failClosed || st.ready {
				t.Fatalf("a younger explicit claim must fail closed behind an opaque holder: %+v", st)
			}
			if !strings.Contains(st.message, "legacy/api") || !strings.Contains(strings.ToLower(st.message), "secret") {
				t.Fatalf("the condition must name the holder and say its prefix is in a Secret: %q", st.message)
			}
			if h.prov.hasUser(h.userOf(young)) {
				t.Fatal("the younger app was issued a user")
			}

			// A younger app on its derived prefix is not blocked: the derived shape belongs
			// to the app it derives from, and ranks first.
			derivedApp := aclAppAt("shop", "api", "", "", tYoung)
			h.createSibling(t, derivedApp)
			if st := h.reconcileApp(t, derivedApp); !notBlocked(st) {
				t.Fatalf("an app on its own derived prefix must not be blocked: %+v", st)
			}
		})
	}

	t.Run("an older explicit app is not blocked by a younger opaque one", func(t *testing.T) {
		h := newACLHarness(t, true)
		old := aclAppAt("shop", "web", "team", "", tOld)
		young := aclAppAt("legacy", "api", "x", cacheIsolationNone, tYoung)
		withEnvMapPrefix(young)
		h.createSibling(t, old)
		h.createSibling(t, young)
		if st := h.reconcileApp(t, old); !notBlocked(st) {
			t.Fatalf("%+v", st)
		}
	})

	// The opaque app sits between two explicit claims: it blocks the younger one and
	// not the older one, whatever the explicit claims say.
	t.Run("an opaque app in the middle blocks only what is younger", func(t *testing.T) {
		h := newACLHarness(t, true)
		first := aclAppAt("shop", "first", "a", "", tOld)
		opaque := aclAppAt("legacy", "api", "x", cacheIsolationNone, tOld.Add(time.Hour))
		withEnvMapPrefix(opaque)
		last := aclAppAt("shop", "last", "b", "", tOld.Add(2*time.Hour))
		for _, a := range []*appsv1alpha1.NextApp{first, opaque, last} {
			h.createSibling(t, a)
		}
		if st := h.reconcileApp(t, first); !notBlocked(st) {
			t.Fatalf("the older claim: %+v", st)
		}
		if st := h.reconcileApp(t, last); st.reason != ReasonCachePrefixConflict {
			t.Fatalf("the younger claim must fail closed behind the opaque app: %+v", st)
		}
	})
}

// The same, for the finalizer: the refused younger app has no Secret, so it takes
// the plain path with its own spec.cache.url, and an app that was alone in view
// when it was provisioned has a user. Neither may sweep the older holder's keys.
func TestFinalizerOfAYoungerAppNeverSweepsKeysAnEnvSetPrefixHolds(t *testing.T) {
	forms := map[string]func(*appsv1alpha1.NextApp){
		"a literal in spec.env":             withEnvPrefix("team"),
		"a Secret in envMap":                withEnvMapPrefix,
		"a literal nested inside the claim": withEnvPrefix("team:sub"),
	}
	for name, mutate := range forms {
		t.Run("refused, no Secret: "+name, func(t *testing.T) {
			h := newACLHarness(t, true)
			h.enablePlatformLookup(t)
			old := aclAppAt("legacy", "api", "x", cacheIsolationNone, tOld)
			mutate(old)
			h.createSibling(t, old)
			young := aclAppAt("shop", "web", "team", "", tYoung)
			h.createSibling(t, young)
			if st := h.reconcileApp(t, young); st.reason != ReasonCachePrefixConflict {
				t.Fatalf("setup: %+v", st)
			}
			cleaner, _ := h.finalize(t, young)
			if len(cleaner.cache) != 0 {
				t.Fatalf("deleting the younger app swept keys an older app holds: %+v", cleaner.cache)
			}
		})
		t.Run("had a user, holder arrived later: "+name, func(t *testing.T) {
			h := newACLHarness(t, true)
			h.enablePlatformLookup(t)
			young := aclAppAt("shop", "web", "team", "", tYoung)
			h.createSibling(t, young)
			st := h.reconcileApp(t, young)
			if !st.ready {
				t.Fatalf("setup: %+v", st)
			}
			old := aclAppAt("legacy", "api", "x", cacheIsolationNone, tOld)
			mutate(old)
			h.createSibling(t, old)

			cleaner, _ := h.finalize(t, young)
			if len(cleaner.cache) != 0 {
				t.Fatalf("a younger app with a user swept keys an older app holds: %+v", cleaner.cache)
			}
			if h.prov.hasUser(st.username) {
				t.Fatal("the younger app's own user must still be removed")
			}
		})
	}
}

// The isolation claim looks at the keys every app on the endpoint writes, the ones
// set through env included, and cannot vouch for an app whose prefix it cannot see.
func TestIsolationClaimCountsPrefixesSetThroughEnvAndDoubtsOpaqueOnes(t *testing.T) {
	t.Run("a shared user over an env-set prefix", func(t *testing.T) {
		h := newACLHarness(t, true)
		old := aclAppAt("legacy", "api", "x", "", tOld)
		withEnvPrefix("billing")(old)
		h.createSibling(t, old)
		h.prov.addUser("reporter", true, "~billing:*")
		st := h.reconcileApp(t, aclAppAt("shop", "web", "shop-web", "", tYoung))
		assertNoIsolationClaim(t, st, "a user that reaches an env-set prefix")
	})
	t.Run("a shared user over a prefix nobody has is harmless", func(t *testing.T) {
		h := newACLHarness(t, true)
		old := aclAppAt("legacy", "api", "x", "", tOld)
		withEnvPrefix("billing")(old)
		h.createSibling(t, old)
		h.prov.addUser("reporter", true, "~session:*")
		st := h.reconcileApp(t, aclAppAt("shop", "web", "shop-web", "", tYoung))
		if st.reason != ReasonCacheProvisioned {
			t.Fatalf("%+v", st)
		}
	})
	t.Run("an opaque app means any shared user with keys might reach it", func(t *testing.T) {
		h := newACLHarness(t, true)
		old := aclAppAt("legacy", "api", "x", "", tYoung)
		withEnvMapPrefix(old)
		h.createSibling(t, old)
		h.prov.addUser("reporter", true, "~session:*")
		st := h.reconcileApp(t, aclAppAt("shop", "web", "shop-web", "", tOld))
		assertNoIsolationClaim(t, st, "a user with keys beside an app whose prefix is unknown")
	})
}
