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

package validation

import (
	"strings"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #2451: a REDIS_KEY_PREFIX set through spec.env is the app's key prefix as much
// as spec.cache.keyPrefix is, so it gets the same rules.
func TestValidateNextAppSpec_EnvRedisKeyPrefix(t *testing.T) {
	spec := func(v string) *appsv1alpha1.NextAppSpec {
		return &appsv1alpha1.NextAppSpec{Image: "r/a@sha256:" + strings.Repeat("a", 64), Env: map[string]string{"REDIS_KEY_PREFIX": v}}
	}
	refused := []struct{ name, value string }{
		{"the shared fallback keyspace", "kn-next"},
		{"under the shared fallback keyspace", "kn-next:isr"},
		{"the platform keyspace", "knext"},
		{"under the platform keyspace", "knext:cdn:purged"},
		{"a glob star", "app*"},
		{"a glob question mark", "app?"},
		{"a glob bracket", "app[1]"},
		{"a backslash", `app\x`},
		{"whitespace", "my app"},
		{"a newline", "app\n"},
		{"longer than 63 code points", strings.Repeat("a", 64)},
	}
	for _, c := range refused {
		t.Run("refuses "+c.name, func(t *testing.T) {
			err := ValidateNextAppSpec(spec(c.value))
			if err == nil || !strings.Contains(err.Error(), "spec.env[REDIS_KEY_PREFIX]") {
				t.Fatalf("ValidateNextAppSpec(%q) = %v, want an error naming spec.env[REDIS_KEY_PREFIX]", c.value, err)
			}
		})
	}
	for _, v := range []string{"", "shop", "shop:web", strings.Repeat("é", 63)} {
		if err := ValidateNextAppSpec(spec(v)); err != nil {
			t.Fatalf("ValidateNextAppSpec(%q) = %v, want accepted", v, err)
		}
	}
}

// The derived-shape rule needs the app's namespace and name, so it is checked
// with the explicit keyPrefix in ValidateNextAppCacheKeyPrefix.
func TestValidateNextAppCacheKeyPrefix_EnvDerivedShape(t *testing.T) {
	spec := func(v string) *appsv1alpha1.NextAppSpec {
		return &appsv1alpha1.NextAppSpec{Env: map[string]string{"REDIS_KEY_PREFIX": v}}
	}
	if err := ValidateNextAppCacheKeyPrefix("shop", "web", spec(DerivedCacheKeyPrefix("shop", "api"))); err == nil ||
		!strings.Contains(err.Error(), "spec.env[REDIS_KEY_PREFIX]") {
		t.Fatalf("another app's derived prefix through spec.env: err = %v, want refused naming spec.env", err)
	}
	if err := ValidateNextAppCacheKeyPrefix("shop", "web", spec(shopWebDerived)); err != nil {
		t.Fatalf("the app's own derived prefix through spec.env: err = %v, want accepted", err)
	}
	if err := ValidateNextAppCacheKeyPrefix("shop", "web", spec("")); err != nil {
		t.Fatalf("an empty spec.env REDIS_KEY_PREFIX is unset: err = %v", err)
	}
}
