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
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ADR-0071 D7 and the review's M2: the finalizer decides from the operator-owned
// Secret and the platform registration, NEVER from status.cache. Status is
// cleared on every pass that is not ready, so an app deleted during a refusal,
// or after a switch to isolation: none, would otherwise leak its ACL user.

// enablePlatformLookup makes loadPlatform read the registration the way the
// manager does.
func (h *aclHarness) enablePlatformLookup(t *testing.T) {
	t.Helper()
	if err := h.c.Create(context.Background(), h.snap.obj.DeepCopy()); err != nil {
		t.Fatal(err)
	}
	h.r.PlatformCRDPresent = true
}

// deregister removes the endpoint from the live platform object.
func (h *aclHarness) deregister(t *testing.T) {
	t.Helper()
	cur := h.snap.obj.DeepCopy()
	if err := h.c.Get(context.Background(), client.ObjectKeyFromObject(cur), cur); err != nil {
		t.Fatal(err)
	}
	cur.Spec.Cache.RedisEndpoints = nil
	if err := h.c.Update(context.Background(), cur); err != nil {
		t.Fatal(err)
	}
}

type orderedCleaner struct {
	cache  []CacheTarget
	onSwep func(CacheTarget)
}

func (c *orderedCleaner) CleanupStorage(context.Context, StorageTarget) error { return nil }
func (c *orderedCleaner) CleanupCache(_ context.Context, t CacheTarget) error {
	if c.onSwep != nil {
		c.onSwep(t)
	}
	c.cache = append(c.cache, t)
	return nil
}

func (h *aclHarness) finalize(t *testing.T, app *appsv1alpha1.NextApp) (*orderedCleaner, []string) {
	t.Helper()
	cleaner := &orderedCleaner{}
	h.r.Cleaner = cleaner
	rec := record.NewFakeRecorder(32)
	h.r.Recorder = rec
	if err := h.r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatal(err)
	}
	close(rec.Events)
	var events []string
	for e := range rec.Events {
		events = append(events, e)
	}
	return cleaner, events
}

func provisioned(t *testing.T, h *aclHarness, app *appsv1alpha1.NextApp) cacheCredentialsState {
	t.Helper()
	h.enablePlatformLookup(t)
	st := h.reconcileApp(t, app)
	if !st.ready {
		t.Fatalf("setup: %+v", st)
	}
	return st
}

func TestFinalizerDecidesFromTheSecretNotFromStatus(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st := provisioned(t, h, app)
	app.Status.Cache = nil // cacheStatusFor clears it on every pass that is not ready

	cleaner, _ := h.finalize(t, app)
	if len(cleaner.cache) != 1 || !strings.Contains(cleaner.cache[0].URL, st.username+":") {
		t.Fatalf("the sweep must run as the app's own user, got %+v", cleaner.cache)
	}
	if h.prov.hasUser(st.username) || countOps(h.prov.opsLog(), "DELUSER "+st.username) != 1 {
		t.Fatalf("ACL DELUSER not issued: ops=%v", h.prov.opsLog())
	}
}

func TestFinalizerDeletesTheUserOfAnAppSwitchedToNone(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st := provisioned(t, h, app)
	app.Spec.Cache.Isolation = cacheIsolationNone
	app.Status.Cache = nil

	h.finalize(t, app)
	if h.prov.hasUser(st.username) {
		t.Fatalf("an app that was isolated and is now isolation: none leaked its ACL user: ops=%v", h.prov.opsLog())
	}
}

func TestFinalizerDeletedDuringARefusalStillDeletesTheUser(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st := provisioned(t, h, app)
	// The spec turns invalid while the user exists: the pass fails closed and status is cleared.
	app.Spec.Cache.URL = "redis://u:p@redis.cache.svc.cluster.local:6379"
	if got := h.reconcileApp(t, app); got.reason != ReasonCacheSharedCredentialInSpec {
		t.Fatalf("setup: %+v", got)
	}
	app.Status.Cache = nil

	h.finalize(t, app)
	if h.prov.hasUser(st.username) {
		t.Fatalf("an app deleted during a refusal leaked its ACL user: ops=%v", h.prov.opsLog())
	}
}

// The endpoint is no longer registered: the operator cannot DELUSER, but it must
// still sweep the app's keys with the app's own credential, and it must SAY which
// user it left behind.
func TestFinalizerOnADeregisteredEndpointSweepsAndNamesTheLeftoverUser(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st := provisioned(t, h, app)
	h.deregister(t)
	app.Status.Cache = nil

	cleaner, events := h.finalize(t, app)
	if len(cleaner.cache) != 1 || !strings.Contains(cleaner.cache[0].URL, st.username+":") {
		t.Fatalf("the keys must still be swept as the app's own user: %+v", cleaner.cache)
	}
	var named bool
	for _, e := range events {
		if strings.Contains(e, corev1.EventTypeWarning) && strings.Contains(e, st.username) {
			named = true
		}
		if strings.Contains(e, "pw") && strings.Contains(e, "://") {
			t.Fatalf("an event leaks a URL: %q", e)
		}
	}
	if !named {
		t.Fatalf("a Warning event must name the ACL user left on the endpoint, got %v", events)
	}
}

// D7: "If the user was lost to a restart, it re-asserts the user first."
func TestFinalizerReassertsALostUserBeforeTheSweep(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	st := provisioned(t, h, app)
	delete(h.prov.users, st.username) // a Redis restart lost every user
	app.Status.Cache = nil

	var userAtSweep bool
	cleaner := &orderedCleaner{onSwep: func(CacheTarget) { userAtSweep = h.prov.hasUser(st.username) }}
	h.r.Cleaner = cleaner
	if err := h.r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatal(err)
	}
	if !userAtSweep {
		t.Fatalf("the user must be re-asserted BEFORE the sweep, or the sweep runs as nobody: ops=%v", h.prov.opsLog())
	}
	if h.prov.hasUser(st.username) {
		t.Fatal("the user must be gone at the end")
	}
}

// A loser that is deleted must not sweep the owner's keys, and must not be given a
// user to do it with.
func TestFinalizerOfALosingAppNeverSweepsTheOwnersKeys(t *testing.T) {
	h := newACLHarness(t, true)
	h.enablePlatformLookup(t)
	young := aclAppAt("evil", "squat", "team", "", tYoung)
	h.createSibling(t, young)
	h.reconcileApp(t, young) // alone in view: provisioned, and holds a Secret
	old := aclAppAt("shop", "web", "team", "", tOld)
	h.createSibling(t, old)
	if st := h.reconcileApp(t, old); st.reason != ReasonCacheProvisioned {
		t.Fatalf("setup: %+v", st)
	}
	young.Status.Cache = nil

	ownerUser := h.userOf(old)
	opsBefore := len(h.prov.opsLog())
	cleaner, _ := h.finalize(t, young)
	if len(cleaner.cache) != 0 {
		t.Fatalf("a losing app swept a keyspace it does not own: %+v", cleaner.cache)
	}
	for _, op := range h.prov.opsLog()[opsBefore:] {
		if strings.HasPrefix(op, "SETUSER") {
			t.Fatalf("the finalizer issued a user to a losing app: %s", op)
		}
	}
	if !h.prov.hasUser(ownerUser) {
		t.Fatal("the owner's user was deleted")
	}
}

// Unchanged behaviour: an app that never had a credentials Secret is swept with the
// credential it has in spec.cache.url.
func TestFinalizerWithoutACredentialsSecretKeepsThePlainPath(t *testing.T) {
	for name, registered := range map[string]bool{"registered endpoint": true, "unregistered endpoint": false} {
		t.Run(name, func(t *testing.T) {
			h := newACLHarness(t, registered)
			if registered {
				h.enablePlatformLookup(t)
			}
			app := aclApp("shop", "web", "shop-web", cacheIsolationNone)
			cleaner, _ := h.finalize(t, app)
			if len(cleaner.cache) != 1 || cleaner.cache[0].URL != aclTestURL {
				t.Fatalf("plain path expected, got %+v", cleaner.cache)
			}
			if len(h.prov.opsLog()) != 0 {
				t.Fatalf("no ACL command for an app that never had a user: %v", h.prov.opsLog())
			}
		})
	}
}
