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
	"fmt"
	"os"
	"sync"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The per-app Redis ACL user through a REAL Reconcile against an apiserver
// (ADR-0071 D6a, D2, D7): real creationTimestamps and uids, the real status
// subresource, the real CRD schema. Redis itself is the in-memory fake; what is
// under test is the operator's decisions and what they leave in the API.

const (
	aclEnvNS     = "default"
	aclEnvURL    = "redis://redis.cache.svc.cluster.local:6379"
	aclEnvEndpt  = "redis.cache.svc.cluster.local:6379"
	aclEnvSecret = "redis-provisioner"
	aclEnvPrefix = "contested"
)

// laggingClient hides chosen NextApps from List, the way an informer that has not
// caught up does. Get and writes are unaffected.
type laggingClient struct {
	client.Client
	mu     sync.Mutex
	hidden map[string]bool
}

func (c *laggingClient) hide(names ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.hidden = map[string]bool{}
	for _, n := range names {
		c.hidden[n] = true
	}
}

func (c *laggingClient) List(ctx context.Context, list client.ObjectList, opts ...client.ListOption) error {
	if err := c.Client.List(ctx, list, opts...); err != nil {
		return err
	}
	apps, ok := list.(*appsv1alpha1.NextAppList)
	if !ok {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	kept := apps.Items[:0]
	for _, a := range apps.Items {
		if !c.hidden[a.Namespace+"/"+a.Name] {
			kept = append(kept, a)
		}
	}
	apps.Items = kept
	return nil
}

// failingNamespaceReader fails the kube-system read the cluster identity needs.
type failingNamespaceReader struct {
	client.Reader
	fail bool
}

func (r *failingNamespaceReader) Get(ctx context.Context, key client.ObjectKey, obj client.Object, opts ...client.GetOption) error {
	if _, isNS := obj.(*corev1.Namespace); isNS && r.fail {
		return errors.New("etcdserver: request timed out")
	}
	return r.Reader.Get(ctx, key, obj, opts...)
}

type aclEnv struct {
	r    *NextAppReconciler
	lag  *laggingClient
	prov *fakeProvisioner
	rdr  *failingNamespaceReader
}

func newACLEnv(ctx context.Context) *aclEnv {
	GinkgoHelper()
	prev, had := os.LookupEnv("POD_NAMESPACE")
	Expect(os.Setenv("POD_NAMESPACE", aclEnvNS)).To(Succeed())
	DeferCleanup(func() {
		if had {
			_ = os.Setenv("POD_NAMESPACE", prev)
		} else {
			_ = os.Unsetenv("POD_NAMESPACE")
		}
	})

	sec := &corev1.Secret{
		Name: aclEnvSecret, Namespace: aclEnvNS,
		Data: map[string][]byte{"url": []byte("redis://provisioner:pw@" + aclEnvEndpt)},
	}
	Expect(k8sClient.Create(ctx, sec)).To(Succeed())
	DeferCleanup(func() { _ = k8sClient.Delete(ctx, sec) })

	DeferCleanup(func() { deletePlatformIfPresent(ctx, "default") })
	Expect(k8sClient.Create(ctx, rawPlatform("default", map[string]any{
		"cache": map[string]any{"redisEndpoints": []any{map[string]any{
			"endpoint":             aclEnvEndpt,
			"provisionerSecretRef": map[string]any{"name": aclEnvSecret, "key": "url"},
		}}},
	}))).To(Succeed())

	prov := newFakeProvisioner()
	lag := &laggingClient{Client: k8sClient}
	rdr := &failingNamespaceReader{Reader: k8sClient}
	r := &NextAppReconciler{
		Client: lag, Scheme: k8sClient.Scheme(), APIReader: rdr,
		Recorder:           record.NewFakeRecorder(512),
		PlatformCRDPresent: true,
		RedisDialer: func(context.Context, string) (RedisProvisioner, error) {
			return prov, nil
		},
	}
	return &aclEnv{r: r, lag: lag, prov: prov, rdr: rdr}
}

func (e *aclEnv) createApp(ctx context.Context, name, prefix string) *appsv1alpha1.NextApp {
	GinkgoHelper()
	app := &appsv1alpha1.NextApp{
		Name: name, Namespace: aclEnvNS,
		Spec: appsv1alpha1.NextAppSpec{
			Image: validImage,
			Cache: &appsv1alpha1.CacheSpec{Provider: "redis", URL: aclEnvURL, KeyPrefix: prefix},
		},
	}
	Expect(k8sClient.Create(ctx, app)).To(Succeed())
	DeferCleanup(func() {
		deleteAndFinalize(ctx, client.ObjectKeyFromObject(app))
		_ = k8sClient.Delete(ctx, &corev1.Secret{Name: name + "-redis-credentials", Namespace: aclEnvNS})
	})
	return app
}

func (e *aclEnv) reconcile(ctx context.Context, name string) reconcile.Result {
	GinkgoHelper()
	res, err := e.r.Reconcile(ctx, reconcile.Request{Namespace: aclEnvNS, Name: name})
	Expect(err).NotTo(HaveOccurred())
	return res
}

func (e *aclEnv) cacheCondition(ctx context.Context, name string) *metav1.Condition {
	GinkgoHelper()
	got := &appsv1alpha1.NextApp{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: aclEnvNS, Name: name}, got)).To(Succeed())
	return apimeta.FindStatusCondition(got.Status.Conditions, ConditionCacheCredentialsReady)
}

// kubeSystemUID is what the operator derives the cluster tag from.
func kubeSystemUID(ctx context.Context) string {
	GinkgoHelper()
	ns := &corev1.Namespace{}
	Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "kube-system"}, ns)).To(Succeed())
	return string(ns.UID)
}

func (e *aclEnv) ownUser(ctx context.Context, name string) string {
	GinkgoHelper()
	return redisACLUsername(kubeSystemUID(ctx), &appsv1alpha1.NextApp{Namespace: aclEnvNS, Name: name})
}

// waitForNextSecond makes the next object's creationTimestamp strictly later: the
// API serialises it at one-second resolution.
func waitForNextSecond() { time.Sleep(1100 * time.Millisecond) }

var seq int

func uniq(base string) string { seq++; return fmt.Sprintf("%s-%d", base, seq) }

var _ = Describe("Per-app Redis ACL ownership through a real Reconcile (ADR-0071 D6a)", func() {
	ctx := context.Background()

	// Order 1: the younger squatter is provisioned FIRST (the older CR is not yet in
	// the operator's view), then the older owner arrives.
	It("the older app takes the prefix back from a younger squatter that was provisioned first", func() {
		e := newACLEnv(ctx)
		oldName, youngName := uniq("owner"), uniq("squat")
		e.createApp(ctx, oldName, aclEnvPrefix)
		waitForNextSecond()
		e.createApp(ctx, youngName, aclEnvPrefix)

		e.lag.hide(aclEnvNS + "/" + oldName) // the older CR has not reached the operator yet
		e.reconcile(ctx, youngName)
		Expect(e.cacheCondition(ctx, youngName)).NotTo(BeNil())
		Expect(e.prov.hasUser(e.ownUser(ctx, youngName))).To(BeTrue(), "setup: the squatter is alone in view and gets its user")

		e.lag.hide() // the older CR arrives
		e.reconcile(ctx, oldName)
		oldCond := e.cacheCondition(ctx, oldName)
		Expect(oldCond.Status).To(Equal(metav1.ConditionTrue))
		Expect(oldCond.Reason).To(Equal(ReasonCacheProvisioned))
		Expect(e.prov.hasUser(e.ownUser(ctx, youngName))).To(BeFalse(), "the squatter must lose its user the moment the owner is in view")
		Expect(e.prov.hasUser(e.ownUser(ctx, oldName))).To(BeTrue())

		e.reconcile(ctx, youngName)
		cond := e.cacheCondition(ctx, youngName)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal(ReasonCachePrefixConflict))
		Expect(cond.Message).To(ContainSubstring(aclEnvNS + "/" + oldName))
		Expect(e.prov.hasUser(e.ownUser(ctx, youngName))).To(BeFalse())
		Expect(countOps(e.prov.opsLog(), "SETUSER "+e.ownUser(ctx, youngName))).To(Equal(1), "the squatter is never issued a user again")
	})

	// Order 2: the older owner is provisioned first, then the younger arrives.
	It("the older app keeps the prefix when the younger arrives second", func() {
		e := newACLEnv(ctx)
		oldName, youngName := uniq("owner"), uniq("squat")
		e.createApp(ctx, oldName, aclEnvPrefix)
		waitForNextSecond()
		e.createApp(ctx, youngName, aclEnvPrefix)

		e.reconcile(ctx, oldName)
		e.reconcile(ctx, youngName)
		Expect(e.cacheCondition(ctx, oldName).Reason).To(Equal(ReasonCacheProvisioned))
		youngCond := e.cacheCondition(ctx, youngName)
		Expect(youngCond.Status).To(Equal(metav1.ConditionFalse))
		Expect(youngCond.Reason).To(Equal(ReasonCachePrefixConflict))
		Expect(e.prov.hasUser(e.ownUser(ctx, youngName))).To(BeFalse())
		Expect(countOps(e.prov.opsLog(), "SETUSER "+e.ownUser(ctx, youngName))).To(BeZero())
	})

	It("two reconciles at once issue exactly one user", func() {
		e := newACLEnv(ctx)
		oldName, youngName := uniq("owner"), uniq("squat")
		e.createApp(ctx, oldName, aclEnvPrefix)
		waitForNextSecond()
		e.createApp(ctx, youngName, aclEnvPrefix)

		var wg sync.WaitGroup
		for _, n := range []string{youngName, oldName} {
			wg.Add(1)
			go func() {
				defer GinkgoRecover()
				defer wg.Done()
				e.reconcile(ctx, n)
			}()
		}
		wg.Wait()
		Expect(countOps(e.prov.opsLog(), "SETUSER "+e.ownUser(ctx, youngName))).To(BeZero())
		Expect(countOps(e.prov.opsLog(), "SETUSER "+e.ownUser(ctx, oldName))).To(Equal(1))
		Expect(e.cacheCondition(ctx, oldName).Reason).To(Equal(ReasonCacheProvisioned))
		Expect(e.cacheCondition(ctx, youngName).Reason).To(Equal(ReasonCachePrefixConflict))
	})

	// The squat the review found: keyPrefix kn-<victim>:isr is issued
	// ~kn-<victim>:isr:*, the victim's ISR keys. Refused whichever CR is reconciled first.
	DescribeTable("a nested derived prefix is refused, in both orders",
		func(attackerFirst bool) {
			e := newACLEnv(ctx)
			victimName, attackerName := uniq("victim"), uniq("attacker")
			victim := &appsv1alpha1.NextApp{Namespace: aclEnvNS, Name: victimName}
			nested := defaultRedisKeyPrefix(victim) + ":isr"
			e.createApp(ctx, victimName, "")
			e.createApp(ctx, attackerName, nested)

			order := []string{victimName, attackerName}
			if attackerFirst {
				order = []string{attackerName, victimName}
			}
			for _, n := range order {
				e.reconcile(ctx, n)
			}
			cond := e.cacheCondition(ctx, attackerName)
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal(ReasonCachePrefixReserved))
			Expect(e.prov.hasUser(e.ownUser(ctx, attackerName))).To(BeFalse())
			Expect(countOps(e.prov.opsLog(), "SETUSER "+e.ownUser(ctx, attackerName))).To(BeZero())
			Expect(e.cacheCondition(ctx, victimName).Reason).To(Equal(ReasonCacheProvisioned))
			Expect(e.prov.setUserArgs[e.ownUser(ctx, victimName)]).To(ContainElement("~" + defaultRedisKeyPrefix(victim) + ":*"))
			// No Secret was written for the refused app.
			err := k8sClient.Get(ctx, types.NamespacedName{Namespace: aclEnvNS, Name: attackerName + "-redis-credentials"}, &corev1.Secret{})
			Expect(apierrors.IsNotFound(err)).To(BeTrue())
		},
		Entry("attacker reconciled first", true),
		Entry("victim reconciled first", false),
	)
})

var _ = Describe("A transient failure of the cache-credentials step goes through the verdict (review M1)", func() {
	ctx := context.Background()

	It("replaces a stale Provisioned, returns no error, and requeues", func() {
		e := newACLEnv(ctx)
		name := uniq("m1")
		e.createApp(ctx, name, "m1-"+name)

		e.reconcile(ctx, name)
		Expect(e.cacheCondition(ctx, name).Reason).To(Equal(ReasonCacheProvisioned))

		// The cluster identity can no longer be read (an API blip).
		e.rdr.fail = true
		res, err := e.r.Reconcile(ctx, reconcile.Request{Namespace: aclEnvNS, Name: name})
		Expect(err).NotTo(HaveOccurred(), "the error must reach the verdict, not abort the pass before it runs")
		Expect(res.RequeueAfter).To(BeNumerically(">", 0))
		Expect(res.RequeueAfter).To(BeNumerically("<=", time.Minute), "the verdict owns a short retry, not the five-minute resync")

		cond := e.cacheCondition(ctx, name)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse), "a stale Provisioned must not survive a failed pass")
		Expect(cond.Reason).To(Equal(ReasonCacheProvisionerRefused))
		Expect(cond.Message).NotTo(ContainSubstring("isolat"))

		got := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Namespace: aclEnvNS, Name: name}, got)).To(Succeed())
		Expect(got.Status.Cache).To(BeNil(), "status.cache must not keep claiming a user the pass could not confirm")

		// And it recovers on the next healthy pass.
		e.rdr.fail = false
		e.reconcile(ctx, name)
		Expect(e.cacheCondition(ctx, name).Reason).To(Equal(ReasonCacheProvisioned))
	})
})
