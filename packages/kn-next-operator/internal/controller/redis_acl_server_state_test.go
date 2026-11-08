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
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// patternMayCoverPrefix judges an ACL key pattern by its literal head and errs
// toward "covers". The isolation claim rests on it, so a wrong "no" is the
// dangerous direction.
func TestPatternMayCoverPrefix(t *testing.T) {
	cases := []struct {
		pattern, prefix string
		want            bool
	}{
		{"~*", "shop-web", true},
		{"~shop-web:*", "shop-web", true},
		{"~shop-*", "shop-web", true},
		{"~sh*", "shop-web", true},
		{"~?hop-web:*", "shop-web", true},
		{"~[s]hop-web:*", "shop-web", true},
		{"~*:isr", "shop-web", true},
		{"%R~shop-web:*", "shop-web", true},
		{"%W~shop-web:x", "shop-web", true},
		{"%RW~*", "shop-web", true},
		{"~shop-web:*", "shop", false},
		{"~shop:*", "shop-web", false},
		{"~billing:*", "shop-web", false},
		{"~session:42", "shop-web", false},
		{"~shop-web:42", "shop-web", true}, // one key inside the app's space is still the app's key
		{"~shop-web", "shop-web", false},   // the bare key "shop-web" is not under "shop-web:"
		{`~shop\*web:*`, "shop*web", true}, // an escaped glob character is literal
		{`~shop\*web:*`, "shop-web", false},
		{"~knext:cdn:purged:*", "shop-web", false},
	}
	for _, tc := range cases {
		if got := patternMayCoverPrefix(tc.pattern, tc.prefix); got != tc.want {
			t.Errorf("patternMayCoverPrefix(%q, %q) = %v, want %v", tc.pattern, tc.prefix, got, tc.want)
		}
	}
}

// ACL GETUSER arrives as a RESP3 map or a RESP2 flat array, and Redis 7 puts
// further key patterns in selectors.
func TestParseACLGetUser(t *testing.T) {
	resp3 := map[any]any{
		"flags":     []any{"on", "nopass", "sanitize-payload"},
		"keys":      "~app:* %R~other:*",
		"channels":  "&*",
		"commands":  "+@all",
		"selectors": []any{map[any]any{"keys": "~sel:*", "commands": "+get"}},
	}
	got := parseACLGetUser("u", resp3)
	if !got.Enabled || !reflect.DeepEqual(got.KeyPatterns, []string{"~app:*", "%R~other:*", "~sel:*"}) {
		t.Fatalf("RESP3: %+v", got)
	}

	resp2 := []any{
		"flags", []any{"off"},
		"keys", "~*",
		"selectors", []any{[]any{"commands", "+get", "keys", "~sel2:*"}},
	}
	got = parseACLGetUser("u", resp2)
	if got.Enabled || !reflect.DeepEqual(got.KeyPatterns, []string{"~*", "~sel2:*"}) {
		t.Fatalf("RESP2: %+v", got)
	}

	// allkeys is how Redis prints ~*; older servers print bare patterns in an array.
	got = parseACLGetUser("u", map[any]any{"flags": []any{"on"}, "keys": "allkeys"})
	if !reflect.DeepEqual(got.KeyPatterns, []string{"~*"}) {
		t.Fatalf("allkeys: %+v", got)
	}
	got = parseACLGetUser("u", map[any]any{"flags": []any{"on"}, "keys": []any{"app:*", "*"}})
	if !reflect.DeepEqual(got.KeyPatterns, []string{"~app:*", "~*"}) {
		t.Fatalf("array keys: %+v", got)
	}

	// A user with no keys has no patterns and a user with no flags is not enabled.
	got = parseACLGetUser("u", map[any]any{"flags": []any{}, "keys": ""})
	if got.Enabled || len(got.KeyPatterns) != 0 {
		t.Fatalf("empty: %+v", got)
	}
}

// A selector that reaches the app's keys makes a shared user live even when its
// root pattern does not. The fake models GETUSER's merged patterns.
func TestIsolationClaimSeesAUserThroughItsSelector(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.addUser("reader", true, "~billing:*", "%R~shop-web:*")
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	assertNoIsolationClaim(t, st, "a selector over the app's keys")
}

// The rule lives in internal/validation, next to the admission check; the
// operator's derivation must be byte-identical to it.
func TestDerivedPrefixLockstepWithAdmission(t *testing.T) {
	for _, nn := range [][2]string{{"shop", "web"}, {"default", "x"}, {"", ""}, {"a-b", "c-d"}} {
		app := aclTestApp(nn[0], nn[1])
		if got, want := defaultRedisKeyPrefix(app), validation.DerivedCacheKeyPrefix(nn[0], nn[1]); got != want {
			t.Errorf("%v: operator derives %q, admission %q", nn, got, want)
		}
	}
}

// Deleting a squatting CR must not delete the owner's cache. The plain path used
// to sweep any prefix that was not the legacy shared one.
func TestFinalizerNeverSweepsAReservedPrefixOnThePlainPath(t *testing.T) {
	for name, prefix := range map[string]string{
		"the platform keyspace":                    "knext:cdn",
		"another app's derived prefix":             otherAppDerived,
		"a nesting under another app's derived":    otherAppDerived + ":isr",
		"a nesting under this app's own derived":   defaultRedisKeyPrefix(aclTestApp("shop", "web")) + ":isr",
		"the platform keyspace itself":             "knext",
		"a nesting with an empty remainder (edge)": otherAppDerived + ":",
	} {
		t.Run(name, func(t *testing.T) {
			h := newACLHarness(t, false)
			app := aclApp("shop", "web", prefix, cacheIsolationNone)
			cleaner, _ := h.finalize(t, app)
			if len(cleaner.cache) != 0 {
				t.Fatalf("swept %q: %+v", prefix, cleaner.cache)
			}
		})
	}
	// The app's own derived prefix is swept as before.
	h := newACLHarness(t, false)
	app := aclApp("shop", "web", "", cacheIsolationNone)
	if cleaner, _ := h.finalize(t, app); len(cleaner.cache) != 1 || cleaner.cache[0].KeyPrefix != defaultRedisKeyPrefix(app) {
		t.Fatalf("the app's own derived prefix must still be swept: %+v", cleaner.cache)
	}
}

// ── the verdict owns the condition, the event and the requeue (review M1) ───

func cacheVerdict(app *appsv1alpha1.NextApp, st cacheCredentialsState) statusVerdict {
	// A ready Knative Service, so no other input asks for a requeue of its own.
	now := time.Now()
	return computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone}, revisionCheck{},
		imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{},
		podCreationState{}, now, withCacheCredentials(st))
}

func TestVerdictRequeuesTheCacheCredentialsStep(t *testing.T) {
	app := aclApp("shop", "web", "shop-web", "")
	app.Generation = 2
	cases := []struct {
		name  string
		state cacheCredentialsState
		want  time.Duration
	}{
		{"ready re-asserts on the resync interval", cacheCredentialsState{active: true, ready: true, reason: ReasonCacheProvisioned}, cacheResyncInterval},
		{"a transient failure retries soon", transientCacheCredentials(app, errors.New("etcdserver: request timed out")), cacheRetryInterval},
		{"a lost conflict may clear", cacheCredentialsState{active: true, failClosed: true, reason: ReasonCachePrefixConflict}, cacheRetryInterval},
		{"a refused provisioner may recover", cacheCredentialsState{active: true, failClosed: true, reason: ReasonCacheProvisionerRefused}, cacheRetryInterval},
		{"no ACL support may be fixed by an upgrade", cacheCredentialsState{active: true, failClosed: true, reason: ReasonCacheAclUnsupported}, cacheRetryInterval},
		{"a spec refusal waits for a spec change", cacheCredentialsState{active: true, failClosed: true, reason: ReasonCacheSharedCredentialInSpec}, 0},
		{"a reserved prefix waits for a spec change", cacheCredentialsState{active: true, failClosed: true, reason: ReasonCachePrefixReserved}, 0},
		{"an unregistered endpoint waits for a registration", cacheCredentialsState{active: true, failClosed: true, reason: ReasonCacheEndpointUnregistered}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cacheVerdict(app, tc.state).requeueAfter; got != tc.want {
				t.Fatalf("requeueAfter = %v, want %v", got, tc.want)
			}
		})
	}
}

// A stale Provisioned from the previous pass must be replaced, and the change
// must be announced.
func TestVerdictReplacesAStaleProvisionedWithTheTransientState(t *testing.T) {
	app := aclApp("shop", "web", "shop-web", "")
	app.Generation = 2
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionCacheCredentialsReady, Status: metav1.ConditionTrue, Reason: ReasonCacheProvisioned,
		Message: cacheInForceMessage, ObservedGeneration: 2,
	}}
	v := cacheVerdict(app, transientCacheCredentials(app, errors.New("etcdserver: request timed out")))
	c := apimeta.FindStatusCondition(v.conditions, ConditionCacheCredentialsReady)
	if c == nil || c.Status != metav1.ConditionFalse || c.Reason != ReasonCacheProvisionerRefused {
		t.Fatalf("condition = %+v", c)
	}
	var warned bool
	for _, e := range v.events {
		if e.eventType == corev1.EventTypeWarning && e.reason == ReasonCacheProvisionerRefused {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("no Warning event: %+v", v.events)
	}
}

func TestTransientCacheCredentialsNeverLeaksAURL(t *testing.T) {
	app := aclApp("shop", "web", "shop-web", "")
	st := transientCacheCredentials(app, errors.New("dial redis://provisioner:s3cret@redis.cache.svc.cluster.local:6379: refused"))
	if !st.failClosed || st.ready || st.reason != ReasonCacheProvisionerRefused || st.secretName != "web-redis-credentials" {
		t.Fatalf("%+v", st)
	}
	for _, leak := range []string{"s3cret", "provisioner:"} {
		if strings.Contains(st.message, leak) {
			t.Fatalf("message leaks %q: %q", leak, st.message)
		}
	}
	if st.message == "" {
		t.Fatal("the state must say why")
	}
}
