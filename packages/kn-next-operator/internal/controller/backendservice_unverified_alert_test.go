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

	"github.com/prometheus/client_golang/prometheus/testutil"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// --- unverified function Secrets are observable (#2508) -----------------------
//
// A function parked in SovereigntyCompliant=Unknown/SecretsUnverified is held
// silently: transient reads without limit, a denied read for 10 minutes and then
// refused. These tests prove the verdict REPORTS it (a gauge with the start time
// and the reason, so an alert can use the duration) and WARNS before the denied
// teardown. Pure: computeBackendServiceVerdict, never a branch in Reconcile.

func undecidedObs(denied bool, deniedSince *metav1.Time, now time.Time) functionObservation {
	zone, _ := sovFixture()
	return functionObservation{
		zone: zone, zoneListed: true, now: now, deniedSince: deniedSince,
		unverified: []unverifiedSecret{{source: "env", name: "stripe-key", err: "boom", denied: denied}},
	}
}

func TestVerdictReportsTransientUnverifiedWithItsStart(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	bs := sovFunction(specEnvFromSecret("stripe-key"))
	first := computeBackendServiceVerdict(bs, undecidedObs(false, nil, now))
	if first.unverified == nil || first.unverified.reason != unverifiedReasonTransient || !first.unverified.since.Equal(now) {
		t.Fatalf("first pass: want transient since now, got %+v", first.unverified)
	}
	// Later pass: the start is the SovereigntyCompliant transition, not "now".
	started := metav1.NewTime(now.Add(-17 * time.Minute))
	bs.Status.Conditions = []metav1.Condition{{
		Type: ConditionSovereigntyCompliant, Status: metav1.ConditionUnknown,
		Reason: ReasonSecretsUnverified, LastTransitionTime: started,
	}}
	later := computeBackendServiceVerdict(bs, undecidedObs(false, nil, now))
	if later.unverified == nil || !later.unverified.since.Equal(started.Time) {
		t.Fatalf("later pass: want since=%v (survives an operator restart), got %+v", started.Time, later.unverified)
	}
}

func TestVerdictReportsForbiddenFromDeniedSince(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	since := metav1.NewTime(now.Add(-4 * time.Minute))
	v := computeBackendServiceVerdict(sovFunction(specEnvFromSecret("stripe-key")), undecidedObs(true, &since, now))
	if v.unverified == nil || v.unverified.reason != unverifiedReasonForbidden || !v.unverified.since.Equal(since.Time) {
		t.Fatalf("want forbidden since the first denial, got %+v", v.unverified)
	}
}

func TestVerdictReportsNothingWhenDecided(t *testing.T) {
	zone, _ := sovFixture()
	obs := functionObservation{zone: zone, zoneListed: true}
	if v := computeBackendServiceVerdict(sovFunction(specEnvFromSecret("stripe-key")), obs); v.unverified != nil {
		t.Fatalf("a verified function reports no unverified state, got %+v", v.unverified)
	}
}

func warnings(v functionVerdict, reason string) []verdictEvent {
	var out []verdictEvent
	for _, e := range v.events {
		if e.reason == reason && e.eventType == corev1.EventTypeWarning {
			out = append(out, e)
		}
	}
	return out
}

func TestVerdictWarnsOnFirstForbiddenObservationBeforeTeardown(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	since := metav1.NewTime(now)
	bs := sovFunction(specEnvFromSecret("stripe-key")) // status.secretsDeniedSince == nil: first denial
	v := computeBackendServiceVerdict(bs, undecidedObs(true, &since, now))
	ev := warnings(v, ReasonSecretsAccessDenied)
	if len(ev) != 1 {
		t.Fatalf("want exactly one %s Warning at the first denial, got %+v", ReasonSecretsAccessDenied, v.events)
	}
	for _, want := range []string{"stripe-key", "10m", "kubectl auth can-i get secrets"} {
		if !strings.Contains(ev[0].message, want) {
			t.Errorf("event message must contain %q: %s", want, ev[0].message)
		}
	}
}

// Both halves: a denial already under way does not re-emit on every pass, and a
// transient error never produces the denied warning.
func TestVerdictForbiddenWarningIsTransitionGatedAndNotForTransient(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	since := metav1.NewTime(now.Add(-3 * time.Minute))
	bs := sovFunction(specEnvFromSecret("stripe-key"))
	bs.Status.SecretsDeniedSince = &since
	if ev := warnings(computeBackendServiceVerdict(bs, undecidedObs(true, &since, now)), ReasonSecretsAccessDenied); len(ev) != 0 {
		t.Errorf("an ongoing denial must not re-warn every pass: %+v", ev)
	}
	fresh := sovFunction(specEnvFromSecret("stripe-key"))
	if ev := warnings(computeBackendServiceVerdict(fresh, undecidedObs(false, nil, now)), ReasonSecretsAccessDenied); len(ev) != 0 {
		t.Errorf("a transient error is not a denial: %+v", ev)
	}
}

func TestUnverifiedGaugeSetAndClear(t *testing.T) {
	g := backendServiceSecretsUnverifiedSince
	now := time.Unix(1_800_000_000, 0)
	setUnverifiedGauge("ns1", "fn1", &unverifiedReport{reason: unverifiedReasonTransient, since: now})
	if got := testutil.ToFloat64(g.WithLabelValues("ns1", "fn1", unverifiedReasonTransient)); got != 1_800_000_000 {
		t.Fatalf("gauge must carry the start as unix seconds, got %v", got)
	}
	// Reason change replaces the series, it does not leave a stale one.
	setUnverifiedGauge("ns1", "fn1", &unverifiedReport{reason: unverifiedReasonForbidden, since: now})
	if n := testutil.CollectAndCount(g); n != 1 {
		t.Fatalf("want exactly one live series after a reason change, got %d", n)
	}
	setUnverifiedGauge("ns1", "fn1", nil)
	if n := testutil.CollectAndCount(g); n != 0 {
		t.Fatalf("a verified (or deleted) function must leave no series, got %d", n)
	}
}
