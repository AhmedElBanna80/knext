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

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// fakeProvisioner is an in-memory Redis ACL endpoint.
type fakeProvisioner struct {
	version     string
	users       map[string][]string // user -> rules as last set
	patterns    map[string][]string // user -> key patterns reported by GETUSER
	sharedLive  bool
	setErr      error
	delCalls    []string
	setUserArgs map[string][]string
}

func newFakeProvisioner() *fakeProvisioner {
	return &fakeProvisioner{
		version: "7.4.1", users: map[string][]string{}, patterns: map[string][]string{},
		setUserArgs: map[string][]string{},
	}
}

func (f *fakeProvisioner) Close() error                            { return nil }
func (f *fakeProvisioner) Version(context.Context) (string, error) { return f.version, nil }
func (f *fakeProvisioner) SetUser(_ context.Context, u string, rules []string) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.users[u] = rules
	f.setUserArgs[u] = rules
	for _, r := range rules {
		if strings.HasPrefix(r, "~") {
			f.patterns[u] = append(f.patterns[u], r)
		}
	}
	return nil
}
func (f *fakeProvisioner) DelUser(_ context.Context, u string) error {
	f.delCalls = append(f.delCalls, u)
	delete(f.users, u)
	return nil
}
func (f *fakeProvisioner) Users(context.Context) ([]string, error) {
	out := []string{"default"}
	for u := range f.users {
		out = append(out, u)
	}
	return out, nil
}
func (f *fakeProvisioner) KeyPatterns(_ context.Context, u string) ([]string, error) {
	return f.patterns[u], nil
}
func (f *fakeProvisioner) SharedCredentialLive(context.Context) (bool, string, error) {
	return f.sharedLive, "a connection without credentials is accepted", nil
}

const (
	aclTestEndpoint = "redis.cache.svc.cluster.local:6379"
	aclTestURL      = "redis://redis.cache.svc.cluster.local:6379"
)

type aclHarness struct {
	r    *NextAppReconciler
	c    client.Client
	prov *fakeProvisioner
	snap platformSnapshot
}

func newACLHarness(t *testing.T, registered bool, objs ...client.Object) *aclHarness {
	t.Helper()
	t.Setenv("POD_NAMESPACE", "operator-ns")
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	if err := appsv1alpha1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	if err := platformv1alpha1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	all := append([]client.Object{
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "kube-system", UID: types.UID("ks-uid-1")}},
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "redis-provisioner", Namespace: "operator-ns"},
			Data:       map[string][]byte{"url": []byte("redis://provisioner:pw@redis.cache.svc.cluster.local:6379")},
		},
	}, objs...)
	c := fake.NewClientBuilder().WithScheme(s).WithObjects(all...).Build()
	prov := newFakeProvisioner()
	h := &aclHarness{c: c, prov: prov}
	h.r = &NextAppReconciler{
		Client: c, Scheme: s, APIReader: c,
		RedisDialer: func(_ context.Context, u string) (RedisProvisioner, error) {
			if !strings.Contains(u, "provisioner:pw@") {
				return nil, errors.New("wrong provisioner url")
			}
			return prov, nil
		},
	}
	if registered {
		h.snap = platformSnapshot{crdPresent: true, obj: &platformv1alpha1.KnextPlatform{
			ObjectMeta: metav1.ObjectMeta{Name: "default"},
			Spec: platformv1alpha1.KnextPlatformSpec{Cache: &platformv1alpha1.PlatformCache{
				RedisEndpoints: []platformv1alpha1.RedisEndpoint{{
					Endpoint:             aclTestEndpoint,
					ProvisionerSecretRef: platformv1alpha1.ProvisionerSecretRef{Name: "redis-provisioner", Key: "url"},
				}},
			}},
		}}
	}
	return h
}

func aclApp(ns, name, prefix, isolation string) *appsv1alpha1.NextApp {
	app := &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, UID: types.UID(ns + "-" + name)},
		Spec: appsv1alpha1.NextAppSpec{Cache: &appsv1alpha1.CacheSpec{
			Provider: "redis", URL: aclTestURL, KeyPrefix: prefix, Isolation: isolation,
		}},
	}
	return app
}

func (h *aclHarness) secretURL(t *testing.T, app *appsv1alpha1.NextApp) string {
	t.Helper()
	var sec corev1.Secret
	if err := h.c.Get(context.Background(), client.ObjectKey{Namespace: app.Namespace, Name: app.Name + "-redis-credentials"}, &sec); err != nil {
		t.Fatalf("credentials Secret: %v", err)
	}
	return string(sec.Data["REDIS_URL"])
}

func TestCacheCredentialsProvisionsUserAndSecret(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st, err := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	if err != nil || !st.ready || st.failClosed {
		t.Fatalf("state=%+v err=%v", st, err)
	}
	rules, ok := h.prov.users[st.username]
	if !ok {
		t.Fatalf("user %q not created; users=%v", st.username, h.prov.users)
	}
	if !contains(rules, "~shop-web:*") {
		t.Fatalf("rules lack the app's key pattern: %q", rules)
	}
	u := h.secretURL(t, app)
	if !strings.Contains(u, st.username+":") || !strings.HasSuffix(u, "@"+aclTestEndpoint) {
		t.Fatalf("Secret URL %q does not carry the app user on the registered endpoint", u)
	}
	for _, line := range []string{st.message, st.reason} {
		if strings.Contains(line, u) {
			t.Fatalf("status leaks the credential URL")
		}
	}
}

func TestCacheCredentialsReassertKeepsThePassword(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	if _, err := h.r.reconcileCacheCredentials(context.Background(), app, h.snap); err != nil {
		t.Fatal(err)
	}
	first := h.secretURL(t, app)
	delete(h.prov.users, redisACLUsername("ks-uid-1", app)) // a Redis restart loses users
	st, err := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	if err != nil || !st.ready {
		t.Fatalf("state=%+v err=%v", st, err)
	}
	if h.secretURL(t, app) != first {
		t.Fatal("a re-assert changed the password")
	}
	if _, ok := h.prov.users[st.username]; !ok {
		t.Fatal("the user was not re-asserted after the endpoint lost it")
	}
}

// ADR-0071 condition 4: no claim of isolation before the shared path is observed refused.
func TestCacheCredentialsSharedCredentialLiveIsNotAnIsolationClaim(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.sharedLive = true
	st, err := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if err != nil {
		t.Fatal(err)
	}
	if st.reason != ReasonCacheSharedCredentialLive || !strings.Contains(st.message, "isolation not in force: shared credential live") {
		t.Fatalf("reason=%q message=%q", st.reason, st.message)
	}
	if strings.Contains(strings.ToLower(st.message), "isolated") {
		t.Fatalf("message claims isolation while the shared credential is live: %q", st.message)
	}

	h.prov.sharedLive = false
	st, _ = h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if st.reason != ReasonCacheProvisioned {
		t.Fatalf("after the shared path is refused: reason=%q", st.reason)
	}
}

func TestCacheCredentialsUnregisteredEndpoint(t *testing.T) {
	h := newACLHarness(t, false)
	// auto: the shared path, exactly as before the feature.
	st, err := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if err != nil || st.active {
		t.Fatalf("auto on an unregistered endpoint must be inert: %+v %v", st, err)
	}
	if len(h.prov.users) != 0 {
		t.Fatal("provisioned on an unregistered endpoint")
	}
	// acl: fail closed.
	st, _ = h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", "acl"), h.snap)
	if !st.active || !st.failClosed || st.ready || st.reason != ReasonCacheEndpointUnregistered {
		t.Fatalf("acl on an unregistered endpoint must fail closed: %+v", st)
	}
	// none on a registered endpoint: the shared path, no user.
	h2 := newACLHarness(t, true)
	st, _ = h2.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", "none"), h2.snap)
	if st.active || len(h2.prov.users) != 0 {
		t.Fatalf("none must not provision: %+v", st)
	}
}

func TestCacheCredentialsNeverDialsAnUnregisteredHost(t *testing.T) {
	h := newACLHarness(t, true)
	dialed := false
	h.r.RedisDialer = func(context.Context, string) (RedisProvisioner, error) { dialed = true; return h.prov, nil }
	app := aclApp("shop", "web", "shop-web", "acl")
	app.Spec.Cache.URL = "redis://attacker.example.com:6379"
	st, _ := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	if dialed || st.reason != ReasonCacheEndpointUnregistered || !st.failClosed {
		t.Fatalf("dialed=%v state=%+v", dialed, st)
	}
}

func TestCacheCredentialsRefusals(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*appsv1alpha1.NextApp)
		reason string
	}{
		{"userinfo in the url", func(a *appsv1alpha1.NextApp) { a.Spec.Cache.URL = "redis://u:p@redis.cache.svc.cluster.local:6379" }, ReasonCacheSharedCredentialInSpec},
		{"envMap REDIS_URL", func(a *appsv1alpha1.NextApp) {
			a.Spec.Secrets = &appsv1alpha1.SecretsSpec{EnvMap: map[string]appsv1alpha1.EnvMapEntry{"REDIS_URL": {SecretName: "mine", SecretKey: "k"}}}
		}, ReasonCacheSharedCredentialInSpec},
		{"knext prefix", func(a *appsv1alpha1.NextApp) { a.Spec.Cache.KeyPrefix = "knext" }, ReasonCachePrefixReserved},
		{"knext: nested prefix", func(a *appsv1alpha1.NextApp) { a.Spec.Cache.KeyPrefix = "knext:cdn" }, ReasonCachePrefixReserved},
		{"another app's derived prefix", func(a *appsv1alpha1.NextApp) { a.Spec.Cache.KeyPrefix = "kn-0123456789ab" }, ReasonCachePrefixReserved},
		{"prefix set through env is unknown to the operator", func(a *appsv1alpha1.NextApp) {
			a.Spec.Cache.KeyPrefix = ""
			a.Spec.Env = map[string]string{"REDIS_KEY_PREFIX": "mine"}
		}, ReasonCachePrefixUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newACLHarness(t, true)
			app := aclApp("shop", "web", "shop-web", "")
			tc.mutate(app)
			st, err := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
			if err != nil {
				t.Fatal(err)
			}
			if st.reason != tc.reason || !st.failClosed || st.ready {
				t.Fatalf("want fail-closed %q, got %+v", tc.reason, st)
			}
			if len(h.prov.users) != 0 {
				t.Fatal("a user was created despite the refusal")
			}
		})
	}
}

func TestCacheCredentialsOwnDerivedPrefixIsAccepted(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "", "")
	st, err := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	if err != nil || !st.ready {
		t.Fatalf("%+v %v", st, err)
	}
	if !contains(h.prov.users[st.username], "~"+defaultRedisKeyPrefix(app)+":*") {
		t.Fatalf("the user is not scoped to the derived prefix: %q", h.prov.users[st.username])
	}
}

func TestCacheCredentialsPrefixConflict(t *testing.T) {
	cases := []struct {
		name, a, b string
	}{
		{"equal", "team", "team"},
		{"nested", "team", "team:sub"},
		{"containing", "team:sub", "team"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newACLHarness(t, true)
			first := aclApp("shop", "a", tc.a, "")
			if st, _ := h.r.reconcileCacheCredentials(context.Background(), first, h.snap); !st.ready {
				t.Fatalf("first claimant: %+v", st)
			}
			second := aclApp("shop", "b", tc.b, "")
			st, _ := h.r.reconcileCacheCredentials(context.Background(), second, h.snap)
			if st.reason != ReasonCachePrefixConflict || !st.failClosed {
				t.Fatalf("second claimant must fail closed: %+v", st)
			}
			if _, ok := h.prov.users[redisACLUsername("ks-uid-1", second)]; ok {
				t.Fatal("the losing app got a user")
			}
			// The first claimant keeps working: its own re-assert is not a conflict with itself.
			if st, _ := h.r.reconcileCacheCredentials(context.Background(), first, h.snap); !st.ready {
				t.Fatalf("first claimant lost its user: %+v", st)
			}
		})
	}
}

func TestCacheCredentialsSiblingPrefixesDoNotConflict(t *testing.T) {
	h := newACLHarness(t, true)
	for i, p := range []string{"team", "teammate", "other"} {
		app := aclApp("shop", string(rune('a'+i)), p, "")
		if st, _ := h.r.reconcileCacheCredentials(context.Background(), app, h.snap); !st.ready {
			t.Fatalf("prefix %q: %+v", p, st)
		}
	}
}

func TestCacheCredentialsForeignClusterUserConflicts(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.users["knext-app-deadbeef-0123456789ab"] = nil
	h.prov.patterns["knext-app-deadbeef-0123456789ab"] = []string{`~shop-web:*`}
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if st.reason != ReasonCachePrefixConflict {
		t.Fatalf("a foreign-tag user with an overlapping pattern must conflict: %+v", st)
	}
}

func TestCacheCredentialsUnparseablePatternFailsClosed(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.users["knext-app-deadbeef-0123456789ab"] = nil
	h.prov.patterns["knext-app-deadbeef-0123456789ab"] = []string{`~*`}
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if st.reason != ReasonCachePrefixConflict {
		t.Fatalf("a pattern the operator cannot reason about must conflict: %+v", st)
	}
}

func TestCacheCredentialsAclUnsupportedAndRefused(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.version = "6.2.14"
	st, _ := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if st.reason != ReasonCacheAclUnsupported || !st.failClosed {
		t.Fatalf("%+v", st)
	}
	h = newACLHarness(t, true)
	h.prov.setErr = errors.New("NOPERM this user has no permissions to run the 'acl|setuser' command")
	st, _ = h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
	if st.reason != ReasonCacheProvisionerRefused || !st.failClosed {
		t.Fatalf("%+v", st)
	}
}

func TestCacheCredentialsClusterIdentityPrefersClusterID(t *testing.T) {
	h := newACLHarness(t, true)
	h.snap.obj.Spec.Cache.ClusterID = "old-cluster"
	app := aclApp("shop", "web", "shop-web", "")
	st, _ := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	if st.username != redisACLUsername("old-cluster", app) {
		t.Fatalf("username %q does not use spec.cache.clusterId", st.username)
	}
}

func TestInjectCacheCredentialsEnvWinsOverTheSharedURL(t *testing.T) {
	app := aclApp("shop", "web", "shop-web", "acl")
	app.Spec.Secrets = &appsv1alpha1.SecretsSpec{EnvMap: map[string]appsv1alpha1.EnvMapEntry{"OTHER": {SecretName: "s", SecretKey: "k"}}}
	injectCacheCredentialsEnv(app, failClosedCache(app, ReasonCacheEndpointUnregistered, "x"))
	got := app.Spec.Secrets.EnvMap["REDIS_URL"]
	if got.SecretName != "web-redis-credentials" || got.SecretKey != "REDIS_URL" {
		t.Fatalf("REDIS_URL not bound to the operator-owned Secret: %+v", got)
	}
	if _, ok := app.Spec.Secrets.EnvMap["OTHER"]; !ok {
		t.Fatal("the user's other envMap entries were lost")
	}
	// An inactive state must not touch the spec.
	app2 := aclApp("shop", "web", "shop-web", "")
	injectCacheCredentialsEnv(app2, cacheCredentialsState{})
	if app2.Spec.Secrets != nil {
		t.Fatal("inactive state mutated the spec")
	}
}

// The rendered pod env: REDIS_URL is a secretKeyRef, never a literal, and the
// shared URL appears nowhere in it.
func TestIsolatedAppRendersRedisURLFromTheSecret(t *testing.T) {
	r := &NextAppReconciler{}
	app := aclApp("shop", "web", "shop-web", "acl")
	injectCacheCredentialsEnv(app, failClosedCache(app, ReasonCacheEndpointUnregistered, "x"))
	env, _, report := r.buildKsvcEnv(app)
	var found bool
	for _, ev := range env {
		if ev.Name != "REDIS_URL" {
			continue
		}
		found = true
		if ev.Value != "" || ev.ValueFrom == nil || ev.ValueFrom.SecretKeyRef == nil ||
			ev.ValueFrom.SecretKeyRef.Name != "web-redis-credentials" {
			t.Fatalf("REDIS_URL = %+v", ev)
		}
	}
	if !found {
		t.Fatal("no REDIS_URL rendered")
	}
	if !report.empty() {
		t.Fatalf("the operator's own binding is reported as a collision: %+v", report)
	}
}

func TestFinalizerSweepsAsTheAppUserThenDeletesIt(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st, _ := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	if !st.ready {
		t.Fatalf("%+v", st)
	}
	// loadPlatform reads the CRD, so seed it and mark it present.
	if err := h.c.Create(context.Background(), h.snap.obj.DeepCopy()); err != nil {
		t.Fatal(err)
	}
	h.r.PlatformCRDPresent = true
	cleaner := &recordingCleaner{}
	h.r.Cleaner = cleaner
	app.Status.Cache = cacheStatusFor(st)
	if err := h.r.cleanupIsolatedCache(context.Background(), app, "shop-web"); err != nil {
		t.Fatal(err)
	}
	if len(cleaner.cache) != 1 || !strings.Contains(cleaner.cache[0].URL, st.username+":") || cleaner.cache[0].KeyPrefix != "shop-web" {
		t.Fatalf("the sweep must run with the app's own credential: %+v", cleaner.cache)
	}
	if len(h.prov.delCalls) != 1 || h.prov.delCalls[0] != st.username {
		t.Fatalf("ACL DELUSER not issued for the app user: %v", h.prov.delCalls)
	}
}

type recordingCleaner struct{ cache []CacheTarget }

func (c *recordingCleaner) CleanupStorage(context.Context, StorageTarget) error { return nil }
func (c *recordingCleaner) CleanupCache(_ context.Context, t CacheTarget) error {
	c.cache = append(c.cache, t)
	return nil
}
