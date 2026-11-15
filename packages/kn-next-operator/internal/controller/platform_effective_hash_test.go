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
	"time"

	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

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
	// The platform sets no clusterId: the prefix is still the kube-system uid's.
	eff.cdnTagPrefix = cdnTagPrefix("ks-uid", app)

	r := &NextAppReconciler{}
	uid := "ks-uid"
	r.kubeSystemUID.Store(&uid)
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

func TestDecideRollout_APlatformSettingClusterIDPacesTheCDNRerender(t *testing.T) {
	// The same app, but the new platform sets clusterId: the prefix moves, so
	// the re-render must wait for its slot behind the rollout limiter.
	app := &appsv1alpha1.NextApp{Spec: appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{Provider: "cloudflare"}}}
	app.Name, app.Namespace, app.Generation = "web", "default", 3
	apimeta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type: ConditionReconciling, Status: metav1.ConditionFalse, Reason: reasonReconcileOK, ObservedGeneration: 3,
	})
	snap := platformSnapshot{crdPresent: true, obj: &platformv1alpha1.KnextPlatform{
		Spec: platformv1alpha1.KnextPlatformSpec{
			Cache:   &platformv1alpha1.PlatformCache{ClusterID: "prod-eu"},
			Rollout: &platformv1alpha1.PlatformRollout{MaxAppsPerMinute: 1},
		},
	}}
	snap.obj.Name = "default"
	eff := resolveEffective(app, snap.active())
	eff.cdnTagPrefix = cdnTagPrefix("prod-eu", app)

	live := &servingv1.Service{}
	live.Name, live.Namespace = app.Name, app.Namespace
	c := fake.NewClientBuilder().WithScheme(goldenTestScheme(t, false)).WithObjects(live).Build()
	now := time.Unix(1_800_000_000, 0)
	r := &NextAppReconciler{Client: c, Clock: func() time.Time { return now }}
	uid := "ks-uid"
	r.kubeSystemUID.Store(&uid)
	// Another app took this minute's slot.
	r.rollout.reserve(types.NamespacedName{Namespace: "default", Name: "other"}, now, 1)

	gate, err := r.decideRollout(context.Background(), app, snap, eff)
	if err != nil {
		t.Fatal(err)
	}
	if gate.hold != holdRolloutPending {
		t.Fatalf("a clusterId that moves the prefix must be paced, got hold %v", gate.hold)
	}
}

func TestPlatformRollout_AnIdentityHeldAppIsNeitherHeldNorPending(t *testing.T) {
	app := &appsv1alpha1.NextApp{}
	apimeta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
		Type: ConditionCDNAdvisory, Status: metav1.ConditionTrue, Reason: ReasonClusterIdentityUnavailable,
	})
	if !isIdentityHeld(app) {
		t.Fatal("the identity hold is not recognised")
	}
	if isHeldByPlatform(app) {
		t.Fatal("an identity hold is not the platform's doing and must not count as platform-held")
	}
	apimeta.RemoveStatusCondition(&app.Status.Conditions, ConditionCDNAdvisory)
	if isIdentityHeld(app) {
		t.Fatal("no advisory, no identity hold")
	}
}
