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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Review r2: N1 (a finalizer must not sweep an older holder's keys), N4 (the
// finalizer checks the server before it re-asserts and sweeps) and the Minor on a
// transient API error leaking the ACL user.

// finalizeErr is finalize that hands back the error instead of failing the test.
func (h *aclHarness) finalizeErr(t *testing.T, app *appsv1alpha1.NextApp) (*orderedCleaner, []string, error) {
	t.Helper()
	cleaner := &orderedCleaner{}
	h.r.Cleaner = cleaner
	rec := record.NewFakeRecorder(32)
	h.r.Recorder = rec
	err := h.r.cleanupExternalState(context.Background(), app)
	close(rec.Events)
	var events []string
	for e := range rec.Events {
		events = append(events, e)
	}
	return cleaner, events, err
}

// ── N1 ──────────────────────────────────────────────────────────────────────

// The attack: an older app O keeps `team` on the shared credential (isolation:
// none, or a credential in its spec). A younger B copies `team`. B is refused and
// never gets a Secret, so deleting B takes the plain path with its spec.cache.url,
// which on an open Redis would sweep team:* — O's keys.
func TestFinalizerOfAYoungerAppNeverSweepsAnOlderHoldersKeys(t *testing.T) {
	holders := map[string]func(*appsv1alpha1.NextApp){
		"isolation none":      func(a *appsv1alpha1.NextApp) { a.Spec.Cache.Isolation = cacheIsolationNone },
		"userinfo in the url": func(a *appsv1alpha1.NextApp) { a.Spec.Cache.URL = "redis://u:p@redis.cache.svc.cluster.local:6379" },
		"REDIS_URL in envMap": func(a *appsv1alpha1.NextApp) {
			a.Spec.Secrets = &appsv1alpha1.SecretsSpec{EnvMap: map[string]appsv1alpha1.EnvMapEntry{"REDIS_URL": {SecretName: "mine", SecretKey: "k"}}}
		},
	}
	for name, mutate := range holders {
		t.Run(name, func(t *testing.T) {
			h := newACLHarness(t, true)
			h.enablePlatformLookup(t)
			old := aclAppAt("legacy", "api", "team", "", tOld)
			mutate(old)
			h.createSibling(t, old)
			young := aclAppAt("shop", "web", "team", "", tYoung)
			h.createSibling(t, young)
			if st := h.reconcileApp(t, young); st.reason != ReasonCachePrefixConflict {
				t.Fatalf("setup: %+v", st)
			}

			cleaner, _ := h.finalize(t, young)
			if len(cleaner.cache) != 0 {
				t.Fatalf("deleting the younger app swept the older holder's keys: %+v", cleaner.cache)
			}
		})
	}

	// The holder itself, deleted, still sweeps what is its own.
	t.Run("the holder's own deletion still sweeps", func(t *testing.T) {
		h := newACLHarness(t, true)
		h.enablePlatformLookup(t)
		old := aclAppAt("legacy", "api", "team", cacheIsolationNone, tOld)
		h.createSibling(t, old)
		h.createSibling(t, aclAppAt("shop", "web", "team", "", tYoung))
		cleaner, _ := h.finalize(t, old)
		if len(cleaner.cache) != 1 || cleaner.cache[0].KeyPrefix != "team" {
			t.Fatalf("the older holder must sweep its own prefix: %+v", cleaner.cache)
		}
	})

	// A younger app that opted out is no different: it must not reap an older app's keys.
	t.Run("a younger isolation: none app", func(t *testing.T) {
		h := newACLHarness(t, true)
		h.enablePlatformLookup(t)
		h.createSibling(t, aclAppAt("shop", "web", "team", "", tOld))
		young := aclAppAt("legacy", "api", "team", cacheIsolationNone, tYoung)
		h.createSibling(t, young)
		cleaner, _ := h.finalize(t, young)
		if len(cleaner.cache) != 0 {
			t.Fatalf("a younger opted-out app swept an older app's keys: %+v", cleaner.cache)
		}
	})

	// Off a registered endpoint there is no ownership regime: unchanged behaviour.
	t.Run("an unregistered endpoint is unchanged", func(t *testing.T) {
		h := newACLHarness(t, false)
		app := aclApp("shop", "web", "team", cacheIsolationNone)
		cleaner, _ := h.finalize(t, app)
		if len(cleaner.cache) != 1 {
			t.Fatalf("%+v", cleaner.cache)
		}
	})
}

// The same attack where the younger app DID get a Secret and a user (it was alone
// in view when it was provisioned, and the older holder arrived afterwards). The
// server shows no other user over the keys, because the holder has none (it is on
// the shared credential), so only the ownership rule can stop the sweep; the
// server-side check of N4 cannot.
func TestFinalizerOfAYoungerAppWithAUserNeverSweepsAnOlderHoldersKeys(t *testing.T) {
	h := newACLHarness(t, true)
	h.enablePlatformLookup(t)
	young := aclAppAt("shop", "web", "team", "", tYoung)
	h.createSibling(t, young)
	st := h.reconcileApp(t, young)
	if !st.ready {
		t.Fatalf("setup: %+v", st)
	}
	h.createSibling(t, aclAppAt("legacy", "api", "team", cacheIsolationNone, tOld))

	cleaner, _ := h.finalize(t, young)
	if len(cleaner.cache) != 0 {
		t.Fatalf("a younger app with a user swept the older holder's keys: %+v", cleaner.cache)
	}
	if h.prov.hasUser(st.username) {
		t.Fatal("the younger app's own user must still be removed")
	}
}

// ── N4 ──────────────────────────────────────────────────────────────────────

// Before the finalizer re-asserts the app's user and sweeps as it, it asks the
// server: an orphan, another cluster's user, or a leftover from an opted-out app
// that covers the same keys means the sweep would reach keys that are not the
// app's. The app's own user is still removed.
func TestFinalizerChecksTheServerForConflictsBeforeReassertingAndSweeping(t *testing.T) {
	foreign := map[string]string{
		"an orphan of this cluster": "knext-app-" + redisClusterTag("ks-uid-1") + "-aaaaaaaaaaaa",
		"another cluster's user":    "knext-app-deadbeef-bbbbbbbbbbbb",
	}
	for name, other := range foreign {
		for _, lost := range []bool{true, false} {
			label := name + " with the app's user present"
			if lost {
				label = name + " after a Redis restart lost the app's user"
			}
			t.Run(label, func(t *testing.T) {
				h := newACLHarness(t, true)
				app := aclApp("shop", "web", "shop-web", "")
				st := provisioned(t, h, app)
				if lost {
					delete(h.prov.users, st.username)
				}
				h.prov.addUser(other, true, "~shop-web:*")
				before := len(h.prov.opsLog())

				cleaner, _ := h.finalize(t, app)
				if len(cleaner.cache) != 0 {
					t.Fatalf("swept although another user covers the same keys: %+v", cleaner.cache)
				}
				for _, op := range h.prov.opsLog()[before:] {
					if strings.HasPrefix(op, "SETUSER") {
						t.Fatalf("re-asserted the user despite the conflict: %s", op)
					}
				}
				if h.prov.hasUser(st.username) {
					t.Fatal("the app's own user must still be removed")
				}
				if !h.prov.hasUser(other) {
					t.Fatal("a user the operator cannot attribute was deleted")
				}
			})
		}
	}

	// And a pattern it cannot parse is a conflict, not an absence of one.
	t.Run("an unparseable pattern", func(t *testing.T) {
		h := newACLHarness(t, true)
		app := aclApp("shop", "web", "shop-web", "")
		provisioned(t, h, app)
		h.prov.addUser("knext-app-deadbeef-cccccccccccc", true, "~*")
		cleaner, _ := h.finalize(t, app)
		if len(cleaner.cache) != 0 {
			t.Fatalf("swept past a pattern it could not read: %+v", cleaner.cache)
		}
	})
}

// ── Minor: a transient API error must not leak the user ─────────────────────

// flakyClient fails the reads the finalizer makes about the platform and the apps.
type flakyClient struct {
	client.Client
	listErr     error
	platformErr error
}

func (c *flakyClient) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	if _, ok := list.(*appsv1alpha1.NextAppList); ok && c.listErr != nil {
		return c.listErr
	}
	return c.Client.List(ctx, list, opts...)
}

func (c *flakyClient) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if _, ok := obj.(*platformv1alpha1.KnextPlatform); ok && c.platformErr != nil {
		return c.platformErr
	}
	return c.Client.Get(ctx, key, obj, opts...)
}

func TestFinalizerDoesNotLeakTheUserWhenListingAppsFailsTransiently(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st := provisioned(t, h, app)
	h.r.Client = &flakyClient{Client: h.c, listErr: apierrors.NewServiceUnavailable("etcd is busy")}

	cleaner, _, err := h.finalizeErr(t, app)
	if h.prov.hasUser(st.username) {
		t.Fatal("the ACL user was leaked because the app list could not be read")
	}
	if len(cleaner.cache) != 0 {
		t.Fatalf("ownership is unknown, so nothing may be swept: %+v", cleaner.cache)
	}
	if err == nil {
		t.Fatal("a transient API error must be returned so the finalizer runs again, not dropped")
	}

	// The retry, with a healthy API: the keys are swept and the user is gone.
	h.r.Client = h.c
	cleaner, _, err = h.finalizeErr(t, app)
	if err != nil {
		t.Fatalf("the retry failed: %v", err)
	}
	if len(cleaner.cache) != 1 || h.prov.hasUser(st.username) {
		t.Fatalf("the retry must sweep and leave no user: swept=%+v user=%v", cleaner.cache, h.prov.hasUser(st.username))
	}
}

func TestFinalizerRetriesWhenThePlatformCannotBeReadTransiently(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st := provisioned(t, h, app)
	h.r.Client = &flakyClient{Client: h.c, platformErr: apierrors.NewTimeoutError("etcd", 1)}

	cleaner, _, err := h.finalizeErr(t, app)
	if err == nil {
		t.Fatal("the endpoint cannot be resolved, so the user cannot be removed: the error must come back so the finalizer is retried, not dropped")
	}
	if len(cleaner.cache) != 0 {
		t.Fatalf("%+v", cleaner.cache)
	}
	h.r.Client = h.c
	if _, _, err := h.finalizeErr(t, app); err != nil {
		t.Fatalf("the retry failed: %v", err)
	}
	if h.prov.hasUser(st.username) {
		t.Fatal("the retry left the user behind")
	}
}

// A permanent error must not wedge the CR in Terminating: it is a warning and the
// finalizer is released, as for any unreachable dependency.
func TestFinalizerDoesNotWedgeOnAPermanentAPIError(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	provisioned(t, h, app)
	forbidden := apierrors.NewForbidden(schema.GroupResource{Group: "platform.kn-next.dev", Resource: "knextplatforms"}, "default", errors.New("rbac"))
	h.r.Client = &flakyClient{Client: h.c, platformErr: forbidden}

	_, events, err := h.finalizeErr(t, app)
	if err != nil {
		t.Fatalf("a permanent error must not hold the finalizer: %v", err)
	}
	var warned bool
	for _, e := range events {
		if strings.Contains(e, "Warning") {
			warned = true
		}
	}
	if !warned {
		t.Fatalf("a Warning event must say what was left: %v", events)
	}
}
