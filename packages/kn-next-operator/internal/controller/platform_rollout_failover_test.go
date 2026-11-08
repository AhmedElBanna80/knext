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
	"fmt"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
)

// The rollout limiter keeps its reservations in memory (platform_rollout.go).
// When the lease moves to a standby mid-wave the new leader starts with an empty
// limiter against the SAME cluster. These tests pin what that means, and the
// docs (platform-defaults.mdx, "If the operator restarts or fails over") state
// exactly this:
//
//  1. The queue is REBUILT from the cluster, not lost: an app's progress lives
//     in status.platform on the NextApp, so the new leader re-queues exactly the
//     apps that have not rendered yet and finishes the wave.
//  2. No app renders twice: an app the old leader rendered is not re-admitted.
//  3. The cap is exceeded by at most ONE render per failover: the new leader's
//     first slot is free, ignoring that the old leader rendered moments ago.
//     So any 60s window holds at most maxAppsPerMinute+1 renders. It fails
//     toward progress, never toward a stall or a stampede.

// failover replaces the leader: a brand-new reconciler (empty limiter, empty
// fleet-metrics state) over the same cluster and clock.
func (h *platformHarness) failover() {
	h.t.Helper()
	h.r = &NextAppReconciler{
		Client:             h.c,
		Scheme:             h.scheme,
		Recorder:           record.NewFakeRecorder(1000),
		Clock:              func() time.Time { return h.now },
		PlatformCRDPresent: true,
	}
}

// waveHarness boots `apps` rendered apps, then applies one platform edit that
// changes every one of them at perMinute.
type waveHarness struct {
	*platformHarness
	names    []string
	baseline map[string]string // ksvc resourceVersion at the last observation
	renders  map[string]int    // renders of each app since the edit
	times    []time.Time       // instant of every render since the edit
}

func newWave(t *testing.T, apps, perMinute int) *waveHarness {
	t.Helper()
	var objs []client.Object
	w := &waveHarness{baseline: map[string]string{}, renders: map[string]int{}}
	for i := range apps {
		n := fmt.Sprintf("app-%d", i)
		w.names = append(w.names, n)
		objs = append(objs, appNamed(n, nil))
	}
	w.platformHarness = newPlatformHarness(t, objs...)
	for _, n := range w.names {
		w.reconcile(n)
		w.baseline[n] = w.ksvc(n).ResourceVersion
	}
	w.setPlatform(func(s *platformv1alpha1.KnextPlatformSpec) {
		s.Rollout = &platformv1alpha1.PlatformRollout{MaxAppsPerMinute: int32(perMinute)}
		s.Resources = &platformv1alpha1.PlatformResources{Defaults: &platformv1alpha1.PlatformResourceDefaults{CPULimit: "2"}}
	})
	return w
}

// tick reconciles every app once at the current instant and records each render
// (a change of the Knative Service's resourceVersion).
func (w *waveHarness) tick() {
	w.t.Helper()
	for _, n := range w.names {
		w.reconcile(n)
		if rv := w.ksvc(n).ResourceVersion; rv != w.baseline[n] {
			w.baseline[n] = rv
			w.renders[n]++
			w.times = append(w.times, w.now)
		}
	}
}

func (w *waveHarness) rendered() int {
	n := 0
	for _, c := range w.renders {
		if c > 0 {
			n++
		}
	}
	return n
}

// runUntilRendered steps the clock 5s at a time until `want` apps have rendered.
func (w *waveHarness) runUntilRendered(want int) {
	w.t.Helper()
	for range 400 {
		w.tick()
		if w.rendered() >= want {
			return
		}
		w.now = w.now.Add(5 * time.Second)
	}
	w.t.Fatalf("only %d of %d apps rendered", w.rendered(), want)
}

func (w *waveHarness) maxPerWindow() int {
	most := 0
	for _, s := range w.times {
		in := 0
		for _, x := range w.times {
			if !x.Before(s) && x.Before(s.Add(time.Minute)) {
				in++
			}
		}
		if in > most {
			most = in
		}
	}
	return most
}

func TestRolloutFailover_ANewLeaderFinishesTheWaveWithoutRenderingAnAppTwice(t *testing.T) {
	const apps, perMinute = 6, 2
	for _, failAfter := range []int{1, 2, 3} {
		t.Run(fmt.Sprintf("failover_after_%d_rendered", failAfter), func(t *testing.T) {
			w := newWave(t, apps, perMinute)
			w.runUntilRendered(failAfter)
			doneBefore := w.rendered()

			w.failover()
			if got := w.r.rollout.pending(); got != 0 {
				t.Fatalf("setup: a new leader starts with %d reservations, want 0", got)
			}
			// Same instant, new leader: it rebuilds the queue from the cluster.
			w.tick()
			if got := w.r.rollout.pending(); got == 0 {
				t.Errorf("the new leader queued nothing although %d apps are unrendered: the queue was lost", apps-doneBefore)
			}
			if got := w.r.rollout.pending(); got > apps-doneBefore {
				t.Errorf("the new leader queued %d apps but only %d are unrendered: it re-queued rendered apps", got, apps-doneBefore)
			}

			w.runUntilRendered(apps)
			// Let every outstanding slot come due so a double render would show.
			for range 30 {
				w.now = w.now.Add(10 * time.Second)
				w.tick()
			}

			for _, n := range w.names {
				if w.renders[n] != 1 {
					t.Errorf("%s rendered %d times across the failover, want exactly 1", n, w.renders[n])
				}
				if c := w.condition(n, ConditionPlatformDefaultsApplied); c == nil || c.Reason != ReasonInherited {
					t.Errorf("%s ended at %+v, want Inherited: the wave must complete", n, c)
				}
			}
			if got := w.r.rollout.pending(); got != 0 {
				t.Errorf("%d reservations outstanding after the wave", got)
			}
			// The documented bound: at most one extra render per failover.
			if got := w.maxPerWindow(); got > perMinute+1 {
				t.Errorf("%d renders in one minute across a single failover; the documented bound is maxAppsPerMinute+1 = %d (%v)",
					got, perMinute+1, w.times)
			}
		})
	}
}

// The overshoot is real and bounded, not hypothetical: a failover moments after
// a render lets the new leader admit its first app at once. Pinning that it
// happens keeps the docs honest; the test above pins that it is only one.
func TestRolloutFailover_TheNewLeadersFirstSlotIsFreeSoTheCapIsExceededByOne(t *testing.T) {
	const perMinute = 2 // one slot every 30s
	w := newWave(t, 6, perMinute)
	w.tick() // the old leader renders one app at t0
	if w.rendered() != 1 {
		t.Fatalf("setup: %d rendered at t0, want 1", w.rendered())
	}

	w.now = w.now.Add(5 * time.Second) // well inside the 30s spacing
	w.failover()
	w.tick()
	if w.rendered() != 2 {
		t.Fatalf("%d rendered 5s after the old leader's render, want 2: the new leader's first slot is free", w.rendered())
	}

	w.runUntilRendered(6)
	if got := w.maxPerWindow(); got != perMinute+1 {
		t.Errorf("worst minute held %d renders, want exactly maxAppsPerMinute+1 = %d", got, perMinute+1)
	}
}

// A leader that dies between writing an app's Knative Service and writing its
// status leaves the cluster saying "not rendered" about an app that is. The new
// leader re-admits it, but re-applying an identical Service is a no-op, so no
// second revision (and no second pod) is created.
func TestRolloutFailover_AnAppDiedBetweenServiceAndStatusWritesNoSecondRevision(t *testing.T) {
	w := newWave(t, 1, 60)
	frozen := w.app("app-0") // status as the dying leader left it: no platform progress

	w.tick() // both render; the status is written
	for _, n := range w.names {
		if w.renders[n] != 1 {
			t.Fatalf("setup: %s rendered %d times, want 1", n, w.renders[n])
		}
	}
	rv := w.ksvc("app-0").ResourceVersion

	w.failover()
	w.r.Client = &staleNextAppReads{Client: w.c, key: types.NamespacedName{Namespace: "default", Name: "app-0"}, stale: frozen}
	_, _ = w.r.Reconcile(context.Background(), reconcile.Request{Namespace: "default", Name: "app-0"})
	w.r.Client = w.c
	w.reconcile("app-0")

	if got := w.ksvc("app-0").ResourceVersion; got != rv {
		t.Errorf("app-0's Knative Service was rewritten after the failover (rv %s -> %s): a second revision would boot a second pod", rv, got)
	}
}
