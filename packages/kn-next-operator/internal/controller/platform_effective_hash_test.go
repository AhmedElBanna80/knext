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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// preCDNEffectiveHash is effectiveHash as it was before the CDN tag prefix
// joined it, kept here so the test can show a non-CDN app's hash did not move.
func preCDNEffectiveHash(eff effectiveValues) string {
	raw, err := json.Marshal(struct {
		CC                               int64
		CPUReq, MemReq, CPULim, MemLim   string
		Timeout                          int64
		SDD                              string
		TBC, PanicWindow, PanicThreshold *int32
	}{
		eff.containerConcurrency,
		eff.cpuRequest.value, eff.memoryRequest.value, eff.cpuLimit.value, eff.memoryLimit.value,
		eff.timeoutSeconds,
		eff.scaleDownDelay,
		eff.targetBurstCapacity, eff.panicWindowPercentage, eff.panicThresholdPercentage,
	})
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:8])
}

func TestEffectiveHash_NonCDNAppKeepsItsHash(t *testing.T) {
	eff := resolveEffective(&appsv1alpha1.NextApp{}, nil)
	if got, want := effectiveHash(eff), preCDNEffectiveHash(eff); got != want {
		t.Fatalf("a non-CDN app's effective hash moved: got %s, want %s (every app would re-render on upgrade)", got, want)
	}
}

func TestEffectiveHash_TagPrefixMovesIt(t *testing.T) {
	// A change of the cluster identity changes every CDN app's prefix; the hash
	// must see it, or the rollout limiter lets those re-renders through unpaced.
	a := resolveEffective(&appsv1alpha1.NextApp{}, nil)
	b := a
	a.cdnTagPrefix, b.cdnTagPrefix = "83f9eef439ad", "3e0201171791"
	if effectiveHash(a) == effectiveHash(b) {
		t.Fatal("two different CDN tag prefixes give the same effective hash")
	}
}

func TestDecideRollout_APlatformAppearingDoesNotQueueAnUnchangedCDNApp(t *testing.T) {
	// A CDN app rendered before any platform existed (no status.platform). The
	// first KnextPlatform carries no value this app would render differently,
	// so its pass must go now. If the hash fallback ignored the prefix, the app
	// would look changed and the gate would go on to read the live Service: the
	// reconciler here has no client, so that read panics.
	app := &appsv1alpha1.NextApp{Spec: appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{Provider: "cloudflare"}}}
	app.Name, app.Namespace, app.Generation = "web", "default", 3
	apimeta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type: ConditionReconciling, Status: metav1.ConditionFalse, Reason: reasonReconcileOK, ObservedGeneration: 3,
	})
	snap := platformSnapshot{crdPresent: true, obj: &platformv1alpha1.KnextPlatform{}}
	snap.obj.Name = "default"
	eff := resolveEffective(app, snap.active())
	eff.cdnTagPrefix = "83f9eef439ad"

	r := &NextAppReconciler{}
	defer func() {
		if p := recover(); p != nil {
			t.Fatalf("the unchanged CDN app looked changed and the gate read the live Service: %v", p)
		}
	}()
	gate, err := r.decideRollout(context.Background(), app, snap, eff)
	if err != nil || gate.hold != holdNone {
		t.Fatalf("want go now, got hold %v err %v", gate.hold, err)
	}
}

func TestIsHeldByPlatform_CountsAClusterIdentityHold(t *testing.T) {
	app := &appsv1alpha1.NextApp{}
	apimeta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type: ConditionCDNAdvisory, Status: metav1.ConditionTrue, Reason: ReasonClusterIdentityUnavailable,
	})
	if !isHeldByPlatform(app) {
		t.Fatal("an app held on the cluster identity must count as held in the platform's rollout status")
	}
	apimeta.RemoveStatusCondition(&app.Status.Conditions, ConditionCDNAdvisory)
	apimeta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type: ConditionPlatformDefaultsApplied, Status: metav1.ConditionUnknown, Reason: ReasonRolloutPending,
	})
	if isHeldByPlatform(app) {
		t.Fatal("a queued app is pending, not held")
	}
}
