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
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// --- Reconcile-level proof of the unverified series and event (#2508) ---------
//
// The verdict tests prove what is REPORTED; these prove Reconcile PUBLISHES it
// on every path, and only announces a denial once it is persisted.

const unverifiedTestImage = "ghcr.io/acme/pricing@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

// switchReader answers every Secret read with err while err is set, and with
// the inner reader's answer (NotFound for a missing Secret) once cleared.
type switchReader struct {
	err   error
	inner client.Reader
}

func (s *switchReader) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if s.err != nil {
		return s.err
	}
	return s.inner.Get(ctx, key, obj, opts...)
}

func (s *switchReader) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	if s.err != nil {
		return s.err
	}
	return s.inner.List(ctx, list, opts...)
}

type unverifiedHarness struct {
	r      *BackendServiceReconciler
	c      client.Client
	reader *switchReader
	rec    *record.FakeRecorder
	denied int
}

func newUnverifiedHarness(t *testing.T, withZone bool, funcs interceptor.Funcs) *unverifiedHarness {
	t.Helper()
	return newUnverifiedHarnessSpec(t, withZone, specEnvFromSecret("stripe-key"), funcs)
}

func newUnverifiedHarnessSpec(t *testing.T, withZone bool, spec appsv1alpha1.BackendServiceSpec, funcs interceptor.Funcs) *unverifiedHarness {
	t.Helper()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{
		corev1.AddToScheme, networkingv1.AddToScheme, appsv1alpha1.AddToScheme, servingv1.AddToScheme,
	} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	fn := sovFunction(spec)
	fn.Spec.Image = unverifiedTestImage
	fn.Finalizers = []string{BackendServiceFinalizer}
	objs := []client.Object{fn}
	if withZone {
		zone, _ := sovFixture()
		zone.Spec.Backends = []appsv1alpha1.BackendBinding{{Service: fn.Name}}
		objs = append(objs, zone)
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).
		WithStatusSubresource(&appsv1alpha1.BackendService{}).WithInterceptorFuncs(funcs).Build()
	reader := &switchReader{inner: c}
	rec := record.NewFakeRecorder(64)
	return &unverifiedHarness{
		r:      &BackendServiceReconciler{Client: c, Scheme: scheme, APIReader: reader, Recorder: rec},
		c:      c,
		reader: reader,
		rec:    rec,
	}
}

func (h *unverifiedHarness) reconcile() error {
	_, err := h.r.Reconcile(context.Background(), reconcile.Request{
		Namespace: sovNS, Name: "pricing",
	})
	return err
}

// deniedEvents drains the recorder and returns the running total of
// denied-read Warnings seen so far.
func (h *unverifiedHarness) deniedEvents() int {
	for {
		select {
		case e := <-h.rec.Events:
			if strings.Contains(e, ReasonSecretsAccessDenied) {
				h.denied++
			}
		default:
			return h.denied
		}
	}
}

func (h *unverifiedHarness) get(t *testing.T) *appsv1alpha1.BackendService {
	t.Helper()
	bs := &appsv1alpha1.BackendService{}
	if err := h.c.Get(context.Background(), types.NamespacedName{Namespace: sovNS, Name: "pricing"}, bs); err != nil {
		t.Fatal(err)
	}
	return bs
}

func unverifiedSeries(reason string) (float64, bool) {
	// Count first so an absent series is absent, not a created 0.
	if testutil.CollectAndCount(backendServiceSecretsUnverifiedSince) == 0 {
		return 0, false
	}
	v := testutil.ToFloat64(backendServiceSecretsUnverifiedSince.WithLabelValues(sovNS, "pricing", reason))
	return v, v != 0
}

func seriesCount() int { return testutil.CollectAndCount(backendServiceSecretsUnverifiedSince) }

func resetSeries(t *testing.T) {
	t.Helper()
	backendServiceSecretsUnverifiedSince.Reset()
	t.Cleanup(backendServiceSecretsUnverifiedSince.Reset)
}

var errTransient = apierrors.NewTimeoutError("etcd slow", 1)

func TestReconcileClearsSeriesWhenTheFunctionBecomesDecided(t *testing.T) {
	resetSeries(t)
	h := newUnverifiedHarness(t, true, interceptor.Funcs{})
	h.reader.err = errTransient
	if err := h.reconcile(); err == nil {
		t.Fatal("an undecided pass must return the held error")
	}
	if _, ok := unverifiedSeries(unverifiedReasonTransient); !ok {
		t.Fatal("an undecided function must publish its unverified series")
	}
	// The apiserver answers: the Secret does not exist (unmarked), so the
	// function is refused. It is decided; the series must go.
	h.reader.err = nil
	_ = h.reconcile()
	if n := seriesCount(); n != 0 {
		t.Fatalf("a decided function must leave no unverified series, got %d", n)
	}
}

func TestReconcileClearsSeriesWhenTheFunctionIsGone(t *testing.T) {
	resetSeries(t)
	h := newUnverifiedHarness(t, true, interceptor.Funcs{})
	h.reader.err = errTransient
	_ = h.reconcile()
	if seriesCount() != 1 {
		t.Fatal("precondition: one series")
	}
	if err := h.c.Delete(context.Background(), h.get(t)); err != nil {
		t.Fatal(err)
	}
	// The finalizer holds the object with a deletionTimestamp: the deletion path.
	if err := h.reconcile(); err != nil {
		t.Fatal(err)
	}
	if n := seriesCount(); n != 0 {
		t.Fatalf("a function being deleted must leave no series, got %d", n)
	}
}

func TestReconcileClearsSeriesOnNotFound(t *testing.T) {
	resetSeries(t)
	h := newUnverifiedHarness(t, true, interceptor.Funcs{})
	h.reader.err = errTransient
	_ = h.reconcile()
	if seriesCount() != 1 {
		t.Fatal("precondition: one series")
	}
	bs := h.get(t)
	bs.Finalizers = nil
	if err := h.c.Update(context.Background(), bs); err != nil {
		t.Fatal(err)
	}
	if err := h.c.Delete(context.Background(), bs); err != nil {
		t.Fatal(err)
	}
	if err := h.reconcile(); err != nil {
		t.Fatal(err)
	}
	if n := seriesCount(); n != 0 {
		t.Fatalf("a function that no longer exists must leave no series, got %d", n)
	}
}

// An early error return (here: the refused-branch teardown cannot read the
// NetworkPolicy) must not strand a stale series: the pass already knows the
// function is decided.
func TestReconcileClearsSeriesOnAnEarlyErrorReturn(t *testing.T) {
	resetSeries(t)
	failNP := false
	h := newUnverifiedHarness(t, true, interceptor.Funcs{
		Get: func(ctx context.Context, c client.WithWatch, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
			if _, ok := obj.(*networkingv1.NetworkPolicy); ok && failNP {
				return errors.New("apiserver unavailable")
			}
			return c.Get(ctx, key, obj, opts...)
		},
	})
	h.reader.err = errTransient
	_ = h.reconcile()
	if seriesCount() != 1 {
		t.Fatal("precondition: one series")
	}
	h.reader.err, failNP = nil, true
	if err := h.reconcile(); err == nil {
		t.Fatal("the teardown error must be returned")
	}
	if n := seriesCount(); n != 0 {
		t.Fatalf("an early error return must not leave a stale series, got %d", n)
	}
}

// F1: a condition that was Unknown for another reason (ZoneNotFound) for hours
// and then becomes Unknown/SecretsUnverified keeps its LastTransitionTime
// (apimachinery moves it on a STATUS change only). The hold started on the
// transition pass, and must be reported from there, stably.
func TestUnverifiedSinceIsTheTransitionPassAfterAReasonChange(t *testing.T) {
	resetSeries(t)
	// No zone and no Secret reference: Unknown/ZoneNotFound.
	h := newUnverifiedHarnessSpec(t, false, appsv1alpha1.BackendServiceSpec{}, interceptor.Funcs{})
	if err := h.reconcile(); err != nil {
		t.Fatal(err)
	}
	bs := h.get(t)
	sov := apimeta.FindStatusCondition(bs.Status.Conditions, ConditionSovereigntyCompliant)
	if sov == nil || sov.Reason != ReasonZoneNotFound {
		t.Fatalf("precondition: want ZoneNotFound, got %+v", sov)
	}
	longAgo := metav1.NewTime(time.Now().Add(-3 * time.Hour))
	sov.LastTransitionTime = longAgo
	for i := range bs.Status.Conditions {
		if bs.Status.Conditions[i].Type == ConditionSovereigntyCompliant {
			bs.Status.Conditions[i].LastTransitionTime = longAgo
		}
	}
	if err := h.c.Status().Update(context.Background(), bs); err != nil {
		t.Fatal(err)
	}

	// The function now references a Secret, the zone appears and lists it, and
	// the Secret read fails.
	bs = h.get(t)
	bs.Spec.EnvFrom = specEnvFromSecret("stripe-key").EnvFrom
	if err := h.c.Update(context.Background(), bs); err != nil {
		t.Fatal(err)
	}
	zone, _ := sovFixture()
	zone.Spec.Backends = []appsv1alpha1.BackendBinding{{Service: "pricing"}}
	if err := h.c.Create(context.Background(), zone); err != nil {
		t.Fatal(err)
	}
	h.reader.err = errTransient
	before := time.Now().Add(-2 * time.Second)
	_ = h.reconcile()
	first, ok := unverifiedSeries(unverifiedReasonTransient)
	if !ok {
		t.Fatal("the held function must publish a series")
	}
	if float64(before.Unix()) > first {
		t.Fatalf("pass 1 since=%v is not the transition pass", time.Unix(int64(first), 0))
	}
	_ = h.reconcile()
	second, _ := unverifiedSeries(unverifiedReasonTransient)
	if second != first {
		t.Fatalf("the next pass must report the SAME start: pass1=%v pass2=%v (the stale ZoneNotFound transition leaked: %v)",
			first, second, longAgo.Unix())
	}
	if float64(longAgo.Unix()) == second {
		t.Fatal("since leaked the ZoneNotFound transition time")
	}
}

// F3: the denied Warning is announced only after the status that makes it a
// one-off (SecretsDeniedSince) is persisted; a conflicting write must not leave
// an event behind that the next pass emits again.
func TestDeniedWarningIsEmittedOnlyAfterStatusIsPersisted(t *testing.T) {
	resetSeries(t)
	conflict := true
	h := newUnverifiedHarness(t, true, interceptor.Funcs{
		SubResourceUpdate: func(ctx context.Context, c client.Client, sub string, obj client.Object, opts ...client.SubResourceUpdateOption) error {
			if conflict {
				return apierrors.NewConflict(schema.GroupResource{Group: "apps.kn-next.dev", Resource: "backendservices"}, obj.GetName(), errors.New("stale"))
			}
			return c.SubResource(sub).Update(ctx, obj, opts...)
		},
	})
	h.reader.err = apierrors.NewForbidden(schema.GroupResource{Resource: lcSecrets}, "stripe-key", errors.New("rbac"))
	if err := h.reconcile(); err == nil {
		t.Fatal("a conflicting status write must surface")
	}
	if n := h.deniedEvents(); n != 0 {
		t.Fatalf("no Warning may be emitted before its status is persisted, got %d", n)
	}
	conflict = false
	_ = h.reconcile()
	if n := h.deniedEvents(); n != 1 {
		t.Fatalf("exactly one Warning once persisted, got %d", n)
	}
	_ = h.reconcile()
	if n := h.deniedEvents(); n != 1 {
		t.Fatalf("an ongoing denial must not re-warn, got %d", n)
	}
}
