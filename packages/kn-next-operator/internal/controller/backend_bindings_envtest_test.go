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
	"encoding/json"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The zone half, through a real Reconcile (ADR-0004 Amendment 2 Decision 3):
// the binding env is RENDERED into the zone's Knative Service template, the
// NextApp spec is never written, an unchanged reconcile rolls nothing, and a
// served-version bump rolls exactly one template change. envtest runs no
// Knative controller, so "a revision" is measured the way Knative cuts one: a
// change of the Service's template, observed as metadata.generation.

func reconcileZone(ctx context.Context, ns, name string) {
	_, err := newZoneReconciler().Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: name}})
	Expect(err).NotTo(HaveOccurred())
}

func zoneKsvc(ctx context.Context, ns, name string) *servingv1.Service {
	ksvc := &servingv1.Service{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, ksvc)).To(Succeed())
	return ksvc
}

func zoneEnv(ksvc *servingv1.Service) map[string]string {
	out := map[string]string{}
	for _, e := range ksvc.Spec.Template.Spec.Containers[0].Env {
		out[e.Name] = e.Value
	}
	return out
}

func setServed(ctx context.Context, ns, name, version string) {
	bs := getFunction(ctx, ns, name)
	bs.Status.ServedProtoVersion = version
	Expect(k8sClient.Status().Update(ctx, bs)).To(Succeed())
}

func zoneSpecJSON(ctx context.Context, ns, name string) (string, int64) {
	app := &appsv1alpha1.NextApp{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, app)).To(Succeed())
	b, err := json.Marshal(app.Spec)
	Expect(err).NotTo(HaveOccurred())
	return string(b), app.Generation
}

var _ = Describe("NextApp reconciler: rendering the zone's binding env", func() {
	ctx := context.Background()

	It("renders <NAME>_SERVICE_URL, <NAME>_SERVICE_PROTO_VERSION and KNEXT_WAKE_FUNCTIONS into the template, and never writes NextApp.spec", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, sovZone,
			appsv1alpha1.BackendBinding{Name: "user-profile", Service: "profile"},
			appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", sovZone)
		createFunction(ctx, ns, "profile", sovZone, func(bs *appsv1alpha1.BackendService) { bs.Spec.WakeAhead = new(false) })
		setServed(ctx, ns, "pricing", "1.2.0")
		specBefore, genBefore := zoneSpecJSON(ctx, ns, sovZone)

		reconcileZone(ctx, ns, sovZone)

		env := zoneEnv(zoneKsvc(ctx, ns, sovZone))
		Expect(env).To(HaveKeyWithValue("PRICING_SERVICE_URL", "http://pricing."+ns+".svc.cluster.local"))
		Expect(env).To(HaveKeyWithValue("PRICING_SERVICE_PROTO_VERSION", "1.2.0"))
		Expect(env).To(HaveKeyWithValue("USER_PROFILE_SERVICE_URL", "http://profile."+ns+".svc.cluster.local"))
		Expect(env).NotTo(HaveKey("USER_PROFILE_SERVICE_PROTO_VERSION"), "unset until the function serves: the gateway fails closed")
		Expect(env).To(HaveKeyWithValue(WakeFunctionsEnv, "pricing"), "the opted-out function is left out of the wake list")

		specAfter, genAfter := zoneSpecJSON(ctx, ns, sovZone)
		Expect(specAfter).To(Equal(specBefore), "the operator must never write NextApp.spec")
		Expect(genAfter).To(Equal(genBefore), "a spec write would have bumped metadata.generation")

		app := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: sovZone}, app)).To(Succeed())
		c := apimeta.FindStatusCondition(app.Status.Conditions, ConditionBackendBindings)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionTrue))
	})

	It("rolls no revision on a second reconcile, and exactly one on a served-version bump", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, sovZone, appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", sovZone)
		setServed(ctx, ns, "pricing", lcV100)

		reconcileZone(ctx, ns, sovZone)
		gen1 := zoneKsvc(ctx, ns, sovZone).Generation

		for range 5 {
			reconcileZone(ctx, ns, sovZone)
		}
		Expect(zoneKsvc(ctx, ns, sovZone).Generation).To(Equal(gen1), "an unchanged binding must not change the template")

		setServed(ctx, ns, "pricing", "1.1.0")
		reconcileZone(ctx, ns, sovZone)
		reconcileZone(ctx, ns, sovZone)
		reconcileZone(ctx, ns, sovZone)
		ksvc := zoneKsvc(ctx, ns, sovZone)
		Expect(ksvc.Generation).To(Equal(gen1+1), "a served-version bump rolls exactly one revision")
		Expect(zoneEnv(ksvc)).To(HaveKeyWithValue("PRICING_SERVICE_PROTO_VERSION", "1.1.0"))
	})

	It("does not overwrite a same-named spec.env entry; reports the binding failed and names the variable", func() {
		ns := bsNamespace(ctx)
		app := createZone(ctx, ns, sovZone, appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		app.Spec.Env = map[string]string{"PRICING_SERVICE_URL": "http://dev-pricing.example"}
		Expect(k8sClient.Update(ctx, app)).To(Succeed())
		createFunction(ctx, ns, "pricing", sovZone)

		reconcileZone(ctx, ns, sovZone)
		env := zoneEnv(zoneKsvc(ctx, ns, sovZone))
		Expect(env).To(HaveKeyWithValue("PRICING_SERVICE_URL", "http://dev-pricing.example"))

		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(app), app)).To(Succeed())
		c := apimeta.FindStatusCondition(app.Status.Conditions, ConditionBackendBindings)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonBindingEnvCollision))
		Expect(c.Message).To(ContainSubstring("PRICING_SERVICE_URL"))
	})

	It("refuses a cross-zone backends[] entry: no env, reported on the zone's status", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, sovOther)
		createFunction(ctx, ns, "ledger", sovOther)
		createZone(ctx, ns, sovZone, appsv1alpha1.BackendBinding{Name: "ledger", Service: "ledger"})

		reconcileZone(ctx, ns, sovZone)
		env := zoneEnv(zoneKsvc(ctx, ns, sovZone))
		Expect(env).NotTo(HaveKey("LEDGER_SERVICE_URL"))
		Expect(env).NotTo(HaveKey(WakeFunctionsEnv))

		app := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: sovZone}, app)).To(Succeed())
		c := apimeta.FindStatusCondition(app.Status.Conditions, ConditionBackendBindings)
		Expect(c.Reason).To(Equal(ReasonCrossZoneBinding))
		Expect(c.Message).To(ContainSubstring(`zone "billing"`))
	})

	It("renders nothing for a one-sided binding from the zone side (the function does not exist)", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, sovZone, appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		reconcileZone(ctx, ns, sovZone)
		env := zoneEnv(zoneKsvc(ctx, ns, sovZone))
		Expect(env).NotTo(HaveKey("PRICING_SERVICE_URL"))
		app := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: sovZone}, app)).To(Succeed())
		Expect(apimeta.FindStatusCondition(app.Status.Conditions, ConditionBackendBindings).Reason).To(Equal(ReasonBackendNotFound))
	})

	It("revokes from the zone side: removing the entry drops the binding env on the next render", func() {
		ns := bsNamespace(ctx)
		app := createZone(ctx, ns, sovZone, appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", sovZone)
		reconcileZone(ctx, ns, sovZone)
		Expect(zoneEnv(zoneKsvc(ctx, ns, sovZone))).To(HaveKey("PRICING_SERVICE_URL"))

		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(app), app)).To(Succeed())
		app.Spec.Backends = nil
		Expect(k8sClient.Update(ctx, app)).To(Succeed())
		reconcileZone(ctx, ns, sovZone)
		env := zoneEnv(zoneKsvc(ctx, ns, sovZone))
		Expect(env).NotTo(HaveKey("PRICING_SERVICE_URL"))
		Expect(env).NotTo(HaveKey(WakeFunctionsEnv))
		Expect(k8sClient.Get(ctx, client.ObjectKeyFromObject(app), app)).To(Succeed())
		Expect(apimeta.FindStatusCondition(app.Status.Conditions, ConditionBackendBindings)).To(BeNil())
	})

	It("keeps a user's KNEXT_WAKE_FUNCTIONS untouched when the zone binds nothing (byte-identical render)", func() {
		ns := bsNamespace(ctx)
		app := createZone(ctx, ns, sovZone)
		app.Spec.Env = map[string]string{WakeFunctionsEnv: "whatever"}
		Expect(k8sClient.Update(ctx, app)).To(Succeed())
		reconcileZone(ctx, ns, sovZone)
		var count int
		for _, e := range zoneKsvc(ctx, ns, sovZone).Spec.Template.Spec.Containers[0].Env {
			if e.Name == WakeFunctionsEnv {
				count++
				Expect(e.Value).To(Equal("whatever"))
			}
		}
		Expect(count).To(Equal(1))
	})
})

// A function the zone's pin refuses is not "Bound" on the zone either: the
// zone's BackendBindings condition names the refused binding. The zone's own
// Knative Service does not move a byte (the pin must never roll a zone
// revision), and the condition heals when the pin and the function agree again.
var _ = Describe("NextApp reconciler: BackendBindings and the zone's pins", func() {
	ctx := context.Background()

	zoneBindingsCondition := func(ns string) *metav1.Condition {
		app := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: ns, Name: sovZone}, app)).To(Succeed())
		return apimeta.FindStatusCondition(app.Status.Conditions, ConditionBackendBindings)
	}
	setFunctionImage := func(ns, image string) {
		bs := getFunction(ctx, ns, "pricing")
		bs.Spec.Image = image
		Expect(k8sClient.Update(ctx, bs)).To(Succeed())
	}
	// pinnedZone binds `pricing` to a function whose image carries the pinned digest.
	pinnedZone := func() string {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, sovZone, appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing", Image: pinA})
		createFunction(ctx, ns, "pricing", sovZone, func(bs *appsv1alpha1.BackendService) { bs.Spec.Image = imageA })
		return ns
	}

	It("names the function refused for BindingImageMismatch, leaves the zone's Knative Service untouched, and heals", func() {
		ns := pinnedZone()
		reconcileFunction(ctx, ns, "pricing")
		reconcileZone(ctx, ns, sovZone)
		c := zoneBindingsCondition(ns)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionTrue), "precondition: the matching function is bound")
		before := zoneKsvc(ctx, ns, sovZone)

		By("a principal with only `update` on backendservices swaps the image")
		setFunctionImage(ns, imageB)
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionReady).Reason).To(Equal(ReasonBindingImageMismatch))
		reconcileZone(ctx, ns, sovZone)

		c = zoneBindingsCondition(ns)
		Expect(c).NotTo(BeNil())
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonBindingImageMismatch))
		Expect(c.Message).To(ContainSubstring(`"pricing"`))

		after := zoneKsvc(ctx, ns, sovZone)
		Expect(after.Generation).To(Equal(before.Generation), "the pin must never roll a zone revision")
		Expect(after.Spec.Template).To(Equal(before.Spec.Template), "the zone-render golden is identical")
		Expect(zoneEnv(after)).To(HaveKey("PRICING_SERVICE_URL"))

		By("restoring the pinned image heals the condition")
		setFunctionImage(ns, imageA)
		reconcileFunction(ctx, ns, "pricing")
		reconcileZone(ctx, ns, sovZone)
		Expect(zoneBindingsCondition(ns).Status).To(Equal(metav1.ConditionTrue))
	})

	It("names the function refused for BindingSpecMismatch", func() {
		ns := bsNamespace(ctx)
		createZone(ctx, ns, sovZone, appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
		createFunction(ctx, ns, "pricing", sovZone)
		digest, err := backendSpecDigest(&getFunction(ctx, ns, "pricing").Spec)
		Expect(err).NotTo(HaveOccurred())
		setZoneSpecPin(ctx, ns, digest)
		reconcileFunction(ctx, ns, "pricing")
		reconcileZone(ctx, ns, sovZone)
		Expect(zoneBindingsCondition(ns).Status).To(Equal(metav1.ConditionTrue), "precondition: the pinned spec is bound")

		bs := getFunction(ctx, ns, "pricing")
		bs.Spec.Env = append(bs.Spec.Env, corev1.EnvVar{Name: "EXTRA", Value: "1"})
		Expect(k8sClient.Update(ctx, bs)).To(Succeed())
		reconcileFunction(ctx, ns, "pricing")
		Expect(functionCondition(getFunction(ctx, ns, "pricing"), ConditionReady).Reason).To(Equal(ReasonBindingSpecMismatch))
		reconcileZone(ctx, ns, sovZone)

		c := zoneBindingsCondition(ns)
		Expect(c.Status).To(Equal(metav1.ConditionFalse))
		Expect(c.Reason).To(Equal(ReasonBindingSpecMismatch))
		Expect(c.Message).To(ContainSubstring(`"pricing"`))
	})
})
