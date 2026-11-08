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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlmetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// bsReconcileCount is the backendservice controller's reconcile total, all results.
func bsReconcileCount() float64 {
	families, err := ctrlmetrics.Registry.Gather()
	Expect(err).NotTo(HaveOccurred())
	var total float64
	for _, mf := range families {
		if mf.GetName() != "controller_runtime_reconcile_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			if metricHasLabel(m, "controller", "backendservice") {
				total += m.GetCounter().GetValue()
			}
		}
	}
	return total
}

// #2501: the function reconciler watches NextApps (zones) for what its verdict
// reads: a zone appearing or going, and a zone's spec (backends, database).
// The NextApp reconciler writes status often (conditions, observedGeneration),
// and before the predicate every such write re-checked every function in the
// namespace, each with uncached Secret and ConfigMap GETs.
var _ = Describe("BackendService reconciler: the zone watch passes spec changes, not status writes (#2501)", func() {
	It("enqueues no function for a zone status write, and re-checks them on a zone spec change", func(ctx SpecContext) {
		const zones, perZone, writes = 4, 3, 5
		ns := bsNamespace(ctx)
		for z := range zones {
			zone := fmt.Sprintf("zone-%d", z)
			createZone(ctx, ns, zone)
			for f := range perZone {
				createFunction(ctx, ns, fmt.Sprintf("fn-%d-%d", z, f), zone)
			}
		}

		mgrCtx, mgrCancel := context.WithCancel(ctx)
		mgrDone := make(chan struct{})
		DeferCleanup(func() {
			mgrCancel()
			Eventually(mgrDone, "30s").Should(BeClosed(), "the manager must stop before the next spec runs")
		})
		mgr, err := ctrl.NewManager(cfg, ctrl.Options{
			Scheme: k8sClient.Scheme(),
			// Scoped so the counts are this spec's own objects only.
			Cache:                  cache.Options{DefaultNamespaces: map[string]cache.Config{ns: {}}},
			Metrics:                metricsserver.Options{BindAddress: "0"},
			HealthProbeBindAddress: "0",
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&BackendServiceReconciler{
			Client:    mgr.GetClient(),
			Scheme:    mgr.GetScheme(),
			APIReader: mgr.GetAPIReader(),
			Recorder:  record.NewFakeRecorder(1024),
		}).SetupWithManager(mgr)).To(Succeed())
		go func() {
			defer close(mgrDone)
			_ = mgr.Start(mgrCtx)
		}()

		By("letting the initial reconciles settle")
		settle := func() float64 {
			var last float64 = -1
			Eventually(func() bool {
				cur := bsReconcileCount()
				stable := cur == last && cur > 0
				last = cur
				return stable
			}, "60s", "1s").Should(BeTrue())
			return last
		}
		before := settle()

		By(fmt.Sprintf("writing zone status %d times on each of %d zones", writes, zones))
		for i := range writes {
			for z := range zones {
				app := &appsv1alpha1.NextApp{}
				Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: fmt.Sprintf("zone-%d", z)}, app)).To(Succeed())
				apimeta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
					Type:               "Ready",
					Status:             metav1.ConditionFalse,
					Reason:             fmt.Sprintf("Write%d", i),
					Message:            "status-only write",
					ObservedGeneration: app.Generation,
				})
				Expect(k8sClient.Status().Update(ctx, app)).To(Succeed())
			}
		}
		// Give the watch time to deliver every write before counting.
		time.Sleep(3 * time.Second)
		delta := bsReconcileCount() - before
		GinkgoWriter.Printf("#2501: %d zone status writes -> %.0f function reconciles\n", writes*zones, delta)
		Expect(delta).To(BeZero(), "a status-only zone write must enqueue no function")
		Consistently(bsReconcileCount, "2s", "250ms").Should(Equal(before))

		By("changing one zone's spec")
		app := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: "zone-1"}, app)).To(Succeed())
		app.Spec.Database.SecretRef.Name = "zone-1-db-rotated"
		Expect(k8sClient.Update(ctx, app)).To(Succeed())
		// Every function in the namespace is re-checked: another zone's database
		// feeds the deny rule, so zone-1's change re-checks zone-0's functions too.
		Eventually(bsReconcileCount, "30s", "250ms").Should(BeNumerically(">=", before+zones*perZone))

		By("starting a zone's deletion (a finalizer holds it, so only deletionTimestamp changes)")
		afterSpec := settle()
		held := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: "zone-2"}, held)).To(Succeed())
		held.Finalizers = append(held.Finalizers, "test.kn-next.dev/hold")
		Expect(k8sClient.Update(ctx, held)).To(Succeed())
		DeferCleanup(func(ctx context.Context) {
			cur := &appsv1alpha1.NextApp{}
			if k8sClient.Get(ctx, client.ObjectKey{Namespace: ns, Name: "zone-2"}, cur) == nil {
				cur.Finalizers = nil
				_ = k8sClient.Update(ctx, cur)
			}
		})
		afterFinalizer := settle()
		Expect(afterFinalizer).To(BeNumerically(">=", afterSpec), "a finalizer edit may or may not re-check")
		Expect(k8sClient.Delete(ctx, held)).To(Succeed())
		Eventually(bsReconcileCount, "30s", "250ms").Should(BeNumerically(">=", afterFinalizer+zones*perZone),
			"a zone whose deletion starts must re-check the functions")
	}, SpecTimeout(3*time.Minute))
})
