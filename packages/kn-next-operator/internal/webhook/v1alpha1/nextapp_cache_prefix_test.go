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

package v1alpha1

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ADR-0071 D6a rule 1, at admission: the derived key-prefix shape
// (kn-<12 hex>, optionally followed by ':' and anything) belongs to the app it
// derives from. An explicit spec.cache.keyPrefix in that shape is refused unless
// it EQUALS the app's own derived prefix. The check needs the CR's namespace and
// name, which the shared spec validator does not see, so it lives on the webhook
// path and the reconciler re-applies it (internal/controller).

// derived is deliberately computed here and not through the code under test.
func derived(namespace, name string) string {
	sum := sha256.Sum256([]byte(namespace + "/" + name))
	return "kn-" + hex.EncodeToString(sum[:])[:12]
}

func cacheApp(ns, name, prefix string) *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{
		Namespace: ns, Name: name,
		Spec: appsv1alpha1.NextAppSpec{
			Image: digestImage,
			Cache: &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://redis.cache.svc.cluster.local:6379", KeyPrefix: prefix},
		},
	}
}

func TestAdmissionRefusesTheDerivedPrefixShapeThatIsNotTheAppsOwn(t *testing.T) {
	v := &NextAppCustomValidator{}
	ctx := context.Background()
	victim := derived("shop", "web")
	own := derived("evil", "app")

	refused := map[string]string{
		"another app's derived prefix":               victim,
		"a nesting under another app's derived":      victim + ":isr",
		"a nesting with an empty remainder":          victim + ":",
		"a deep nesting under another app's derived": victim + ":isr:deep",
		"a nesting under the app's own derived":      own + ":isr",
	}
	for name, prefix := range refused {
		t.Run("create refuses "+name, func(t *testing.T) {
			_, err := v.ValidateCreate(ctx, cacheApp("evil", "app", prefix))
			if err == nil || !strings.Contains(err.Error(), "keyPrefix") {
				t.Fatalf("keyPrefix %q must be refused at CREATE, got %v", prefix, err)
			}
		})
		t.Run("update refuses "+name, func(t *testing.T) {
			old := cacheApp("evil", "app", "evil-app")
			_, err := v.ValidateUpdate(ctx, old, cacheApp("evil", "app", prefix))
			if err == nil || !strings.Contains(err.Error(), "keyPrefix") {
				t.Fatalf("keyPrefix %q must be refused at UPDATE, got %v", prefix, err)
			}
		})
	}

	// Near misses are built from the computed prefix, never written out: a literal
	// run of hex beside "prefix" or "keyspace" is what a secret scanner takes for
	// an API key, and none of these are credentials.
	accepted := map[string]string{
		"no explicit prefix":           "",
		"the app's own derived prefix": own,
		"an ordinary prefix":           "shop-web",
		"one hex digit too many":       own + "a",
		"one hex digit too few":        own[:len(own)-1],
		"upper-case hex":               "kn-" + strings.ToUpper(own[3:]),
		"a longer word after the hex":  own + "x",
		"kn- with a non-hex body":      "kn-nothexnothex",
	}
	for name, prefix := range accepted {
		t.Run("create accepts "+name, func(t *testing.T) {
			if _, err := v.ValidateCreate(ctx, cacheApp("evil", "app", prefix)); err != nil {
				t.Fatalf("keyPrefix %q must be accepted, got %v", prefix, err)
			}
		})
	}
}

// A metadata-only update (the finalizer removal) must never be blocked by it.
func TestAdmissionPrefixRuleDoesNotBlockAMetadataOnlyUpdate(t *testing.T) {
	v := &NextAppCustomValidator{}
	squat := cacheApp("evil", "app", derived("shop", "web")+":isr")
	next := squat.DeepCopy()
	next.Finalizers = nil
	if _, err := v.ValidateUpdate(context.Background(), squat, next); err != nil {
		t.Fatalf("a metadata-only update must pass, got %v", err)
	}
}
