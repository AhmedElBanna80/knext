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
	"sync"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ADR-0071 D6a: WHO owns a prefix is decided by rule, never by arrival order.
//
//	0. the derived owner (an app whose prefix is its own derived prefix)
//	1. the oldest metadata.creationTimestamp
//	2. the lexically smallest metadata.uid
//
// evaluated over every app on the same canonical endpoint, and enforced against
// the users that are actually on the endpoint.

var (
	tOld   = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	tYoung = tOld.Add(time.Hour)
)

func aclAppAt(ns, name, prefix, isolation string, created time.Time) *appsv1alpha1.NextApp {
	app := aclApp(ns, name, prefix, isolation)
	app.CreationTimestamp = metav1.NewTime(created)
	return app
}

func (h *aclHarness) reconcileApp(t *testing.T, app *appsv1alpha1.NextApp) cacheCredentialsState {
	t.Helper()
	st, err := h.r.reconcileCacheCredentials(context.Background(), app, h.snap)
	if err != nil {
		t.Fatalf("reconcile %s/%s: %v", app.Namespace, app.Name, err)
	}
	return st
}

func (h *aclHarness) userOf(app *appsv1alpha1.NextApp) string {
	return redisACLUsername("ks-uid-1", app)
}

func countOps(ops []string, op string) int {
	n := 0
	for _, o := range ops {
		if o == op {
			n++
		}
	}
	return n
}

var overlapRelations = []struct {
	name       string
	old, young string
}{
	{"equal", "team", "team"},
	{"the younger nests inside the older", "team", "team:sub"},
	{"the younger contains the older", "team:sub", "team"},
}

// The attack shape in both squatting orders: the younger CR is provisioned
// first (the older is not in the operator's view yet), then the older arrives.
func TestPrefixOwnershipOlderWinsWhenTheYoungerWasProvisionedFirst(t *testing.T) {
	for _, rel := range overlapRelations {
		t.Run(rel.name, func(t *testing.T) {
			h := newACLHarness(t, true)
			young := aclAppAt("evil", "squat", rel.young, "", tYoung)
			old := aclAppAt("shop", "web", rel.old, "", tOld)
			h.createSibling(t, young)

			if st := h.reconcileApp(t, young); !st.ready {
				t.Fatalf("the younger is alone in view and is provisioned first: %+v", st)
			}
			if !h.prov.hasUser(h.userOf(young)) {
				t.Fatal("setup: the younger has no user")
			}

			// The older CR becomes visible and reconciles.
			h.createSibling(t, old)
			st := h.reconcileApp(t, old)
			if !st.ready || st.failClosed || st.reason != ReasonCacheProvisioned {
				t.Fatalf("the older app owns the prefix and must be provisioned: %+v", st)
			}
			if h.prov.hasUser(h.userOf(young)) {
				t.Fatal("the younger squatter still holds a user over the older app's keys")
			}

			// The younger's own next pass: refused, naming the owner, and it never
			// gets a user back.
			before := countOps(h.prov.opsLog(), "SETUSER "+h.userOf(young))
			st = h.reconcileApp(t, young)
			if st.reason != ReasonCachePrefixConflict || !st.failClosed || st.ready {
				t.Fatalf("the younger must fail closed: %+v", st)
			}
			if !strings.Contains(st.message, "shop/web") {
				t.Fatalf("the condition must name the owner: %q", st.message)
			}
			if after := countOps(h.prov.opsLog(), "SETUSER "+h.userOf(young)); after != before {
				t.Fatalf("the losing app was issued a user on a later pass")
			}
			if h.prov.hasUser(h.userOf(young)) {
				t.Fatal("the losing app holds a user")
			}
			if !h.prov.hasUser(h.userOf(old)) {
				t.Fatal("the owner lost its user")
			}
		})
	}
}

// The other order: the older is provisioned, then the younger arrives.
func TestPrefixOwnershipOlderKeepsItWhenTheYoungerArrivesSecond(t *testing.T) {
	for _, rel := range overlapRelations {
		t.Run(rel.name, func(t *testing.T) {
			h := newACLHarness(t, true)
			old := aclAppAt("shop", "web", rel.old, "", tOld)
			young := aclAppAt("evil", "squat", rel.young, "", tYoung)
			h.createSibling(t, old)
			h.createSibling(t, young)

			if st := h.reconcileApp(t, old); st.reason != ReasonCacheProvisioned {
				t.Fatalf("owner: %+v", st)
			}
			st := h.reconcileApp(t, young)
			if st.reason != ReasonCachePrefixConflict || !st.failClosed {
				t.Fatalf("the younger must fail closed: %+v", st)
			}
			if h.prov.hasUser(h.userOf(young)) {
				t.Fatal("the losing app was issued a user")
			}
			if st := h.reconcileApp(t, old); st.reason != ReasonCacheProvisioned {
				t.Fatalf("the owner's re-assert must not conflict with the loser: %+v", st)
			}
		})
	}
}

// The loser's own pass must take its user away even if the owner has not run yet:
// until it does, the squatter still holds a credential over the owner's keys.
func TestPrefixOwnershipLoserRevokesItsOwnUserBeforeTheOwnerRuns(t *testing.T) {
	h := newACLHarness(t, true)
	young := aclAppAt("evil", "squat", "team", "", tYoung)
	h.createSibling(t, young)
	if st := h.reconcileApp(t, young); !st.ready {
		t.Fatalf("setup: %+v", st)
	}
	h.createSibling(t, aclAppAt("shop", "web", "team", "", tOld)) // the owner is in view, and has not reconciled
	st := h.reconcileApp(t, young)
	if st.reason != ReasonCachePrefixConflict {
		t.Fatalf("the younger must lose: %+v", st)
	}
	if h.prov.hasUser(h.userOf(young)) {
		t.Fatal("the loser kept its user until the owner got round to evicting it")
	}
}

// A CR admitted before the reserved-shape rule shipped may already hold a user
// whose pattern reaches another app's keys. Refusing it is not enough.
func TestCacheCredentialsReservedPrefixRevokesAnEarlierUser(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("evil", "app", otherAppDerived+":isr", "")
	h.prov.addUser(h.userOf(app), true, "~"+otherAppDerived+":isr:*")
	st := h.reconcileApp(t, app)
	if st.reason != ReasonCachePrefixReserved || !st.failClosed {
		t.Fatalf("must be refused: %+v", st)
	}
	if h.prov.hasUser(h.userOf(app)) {
		t.Fatal("the refused app keeps a user over the victim's ISR keys")
	}
}

// Arrival order never decides: reconciling the same two CRs in either order ends in
// the same place.
func TestPrefixOwnershipIsIndependentOfReconcileOrder(t *testing.T) {
	for _, olderFirst := range []bool{true, false} {
		h := newACLHarness(t, true)
		old := aclAppAt("shop", "web", "team", "", tOld)
		young := aclAppAt("evil", "squat", "team", "", tYoung)
		h.createSibling(t, old)
		h.createSibling(t, young)
		order := []*appsv1alpha1.NextApp{old, young}
		if !olderFirst {
			order = []*appsv1alpha1.NextApp{young, old}
		}
		for range 2 {
			for _, a := range order {
				h.reconcileApp(t, a)
			}
		}
		if !h.prov.hasUser(h.userOf(old)) || h.prov.hasUser(h.userOf(young)) {
			t.Fatalf("olderFirst=%v: users=%v", olderFirst, h.prov.users)
		}
		if n := countOps(h.prov.opsLog(), "SETUSER "+h.userOf(young)); n != 0 {
			t.Fatalf("olderFirst=%v: the loser was issued a user %d times", olderFirst, n)
		}
	}
}

func TestPrefixOwnershipTiebreakOrder(t *testing.T) {
	t.Run("same second: the smallest uid wins", func(t *testing.T) {
		h := newACLHarness(t, true)
		a := aclAppAt("shop", "a", "team", "", tOld)
		b := aclAppAt("shop", "b", "team", "", tOld.Add(400*time.Millisecond)) // same second
		a.UID, b.UID = types.UID("zzzz"), types.UID("aaaa")
		h.createSibling(t, a)
		h.createSibling(t, b)
		if st := h.reconcileApp(t, a); st.reason != ReasonCachePrefixConflict {
			t.Fatalf("a has the larger uid and must lose: %+v", st)
		}
		if st := h.reconcileApp(t, b); st.reason != ReasonCacheProvisioned {
			t.Fatalf("b has the smaller uid and must win: %+v", st)
		}
	})
	t.Run("creationTimestamp has one-second resolution", func(t *testing.T) {
		if !ownsBefore(claimFor("a", tOld, "aaaa"), claimFor("b", tOld.Add(900*time.Millisecond), "bbbb")) {
			t.Fatal("two timestamps in one second must fall through to the uid")
		}
	})
	t.Run("a derived owner beats an older app", func(t *testing.T) {
		own := claimFor("own", tYoung, "zzzz")
		own.derived = true
		if !ownsBefore(own, claimFor("older", tOld, "aaaa")) {
			t.Fatal("the app whose prefix is its own derived prefix must outrank an older explicit claim")
		}
		if ownsBefore(claimFor("older", tOld, "aaaa"), own) {
			t.Fatal("outranking is not symmetric")
		}
	})
}

func claimFor(name string, created time.Time, uid string) prefixClaim {
	return prefixClaim{ref: "shop/" + name, created: created.Unix(), uid: uid}
}

// Only apps that could actually be issued a user take part. An older CR that is
// itself refused (or opted out) must not hold a prefix against a valid one.
func TestPrefixOwnershipIgnoresAppsThatCannotHoldAUser(t *testing.T) {
	cases := map[string]func(*appsv1alpha1.NextApp){
		"isolation none":         func(a *appsv1alpha1.NextApp) { a.Spec.Cache.Isolation = cacheIsolationNone },
		"userinfo in the url":    func(a *appsv1alpha1.NextApp) { a.Spec.Cache.URL = "redis://u:p@redis.cache.svc.cluster.local:6379" },
		"a reserved prefix":      func(a *appsv1alpha1.NextApp) { a.Spec.Cache.KeyPrefix = "knext" },
		"another endpoint":       func(a *appsv1alpha1.NextApp) { a.Spec.Cache.URL = "redis://other.cache.svc.cluster.local:6379" },
		"no prefix the operator": func(a *appsv1alpha1.NextApp) { a.Spec.Cache.KeyPrefix = "" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			h := newACLHarness(t, true)
			old := aclAppAt("legacy", "api", "team", "", tOld)
			mutate(old)
			h.createSibling(t, old)
			young := aclAppAt("shop", "web", "team", "", tYoung)
			h.createSibling(t, young)
			if st := h.reconcileApp(t, young); st.reason == ReasonCachePrefixConflict || !st.ready {
				t.Fatalf("an older app that cannot hold a user took the prefix: %+v", st)
			}
		})
	}
}

// A user that is not any visible app's still wins (ADR-0071 D6a rule 3): the
// operator never deletes what it cannot attribute.
func TestPrefixOwnershipNeverEvictsAUserItCannotAttribute(t *testing.T) {
	h := newACLHarness(t, true)
	h.prov.addUser("knext-app-"+redisClusterTag("ks-uid-1")+"-0123456789ab", true, "~team:*") // our tag, no CR
	app := aclAppAt("shop", "web", "team", "", tOld)
	h.createSibling(t, app)
	st := h.reconcileApp(t, app)
	if st.reason != ReasonCachePrefixConflict {
		t.Fatalf("an unattributable overlapping user must conflict: %+v", st)
	}
	if len(h.prov.delCalls) != 0 {
		t.Fatalf("the operator deleted a user it cannot attribute: %v", h.prov.delCalls)
	}
}

// The race the tiebreak cannot see: two operators' views disagree, so both pass
// the pre-check and write. The post-write check on the endpoint settles it.
func TestPrefixOwnershipConcurrentClaimAnUnseenUserLandsBetweenCheckAndWrite(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclAppAt("shop", "web", "team", "", tOld)
	h.createSibling(t, app)
	racer := "knext-app-" + redisClusterTag("other-cluster") + "-0123456789ab"
	h.prov.onSetUser = func(string) { h.prov.addUser(racer, true, "~team:*") }

	st := h.reconcileApp(t, app)
	if st.reason != ReasonCachePrefixConflict || !st.failClosed {
		t.Fatalf("both writes landed: the claim must fail closed, got %+v", st)
	}
	if h.prov.hasUser(h.userOf(app)) {
		t.Fatal("the app kept its user although another user now covers its keys")
	}
	if !h.prov.hasUser(racer) {
		t.Fatal("the operator deleted a user it cannot attribute")
	}
}

// Same race, but the other claimant is a visible loser: the owner evicts it.
func TestPrefixOwnershipConcurrentClaimAVisibleLoserLandsBetweenCheckAndWrite(t *testing.T) {
	h := newACLHarness(t, true)
	old := aclAppAt("shop", "web", "team", "", tOld)
	young := aclAppAt("evil", "squat", "team", "", tYoung)
	h.createSibling(t, old)
	h.createSibling(t, young)
	h.prov.onSetUser = func(u string) {
		if u == h.userOf(old) {
			h.prov.addUser(h.userOf(young), true, "~team:*")
		}
	}
	st := h.reconcileApp(t, old)
	if st.reason != ReasonCacheProvisioned {
		t.Fatalf("the owner keeps the prefix: %+v", st)
	}
	if h.prov.hasUser(h.userOf(young)) {
		t.Fatal("the loser's late user was left in place")
	}
}

// Two reconciles at once, both CRs visible: exactly one user ever holds the
// prefix, and the loser is never issued one. Run under -race.
func TestPrefixOwnershipConcurrentReconcilesIssueOneUser(t *testing.T) {
	for i := range 40 {
		h := newACLHarness(t, true)
		old := aclAppAt("shop", "web", "team", "", tOld)
		young := aclAppAt("evil", "squat", "team", "", tYoung)
		h.createSibling(t, old)
		h.createSibling(t, young)
		order := []*appsv1alpha1.NextApp{old, young}
		if i%2 == 1 {
			order = []*appsv1alpha1.NextApp{young, old}
		}
		var wg sync.WaitGroup
		for _, a := range order {
			wg.Go(func() {
				if _, err := h.r.reconcileCacheCredentials(context.Background(), a, h.snap); err != nil {
					t.Error(err)
				}
			})
		}
		wg.Wait()
		if t.Failed() {
			return
		}
		if n := countOps(h.prov.opsLog(), "SETUSER "+h.userOf(young)); n != 0 {
			t.Fatalf("iteration %d: the loser was issued a user", i)
		}
		if n := countOps(h.prov.opsLog(), "SETUSER "+h.userOf(old)); n != 1 {
			t.Fatalf("iteration %d: the owner was written %d times", i, n)
		}
	}
}
