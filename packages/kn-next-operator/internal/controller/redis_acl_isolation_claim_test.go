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
// says nothing but the provisioner and the knext-app-* users can log in with a
// key pattern that reaches an app's keys.

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

// knext-app-* users are scoped by construction, however they print.
func TestIsolationClaimIgnoresTheProvisionerAndKnextAppUsers(t *testing.T) {
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
