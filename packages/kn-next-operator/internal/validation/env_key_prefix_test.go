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

func envSpec(v string) *appsv1alpha1.NextAppSpec {
	return &appsv1alpha1.NextAppSpec{Env: map[string]string{EnvRedisKeyPrefix: v}}
}

// #2451: a REDIS_KEY_PREFIX set through spec.env is the app's key prefix as much
// as spec.cache.keyPrefix is, so admission applies the same rules to it.
func TestValidateNextAppEnvKeyPrefix_Create(t *testing.T) {
	refused := []struct{ name, value string }{
		{"the platform keyspace", "knext"},
		{"under the platform keyspace", "knext:cdn:purged"},
		{"another app's derived prefix", DerivedCacheKeyPrefix("shop", "api")},
		{"a nesting under the app's own derived prefix", shopWebDerived + ":isr"},
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
			err := ValidateNextAppEnvKeyPrefix("shop", "web", nil, envSpec(c.value))
			if err == nil || !strings.Contains(err.Error(), "spec.env[REDIS_KEY_PREFIX]") {
				t.Fatalf("%q: err = %v, want an error naming spec.env[REDIS_KEY_PREFIX]", c.value, err)
			}
		})
	}
	// kn-next is the documented upgrade pin (keep the warm cache); the app's own
	// derived prefix and ordinary prefixes are fine; empty is unset.
	for _, v := range []string{"", "kn-next", "kn-next:isr", "shop", "shop:web", shopWebDerived, strings.Repeat("é", 63)} {
		if err := ValidateNextAppEnvKeyPrefix("shop", "web", nil, envSpec(v)); err != nil {
			t.Fatalf("%q: err = %v, want accepted", v, err)
		}
	}
}

// Ratcheted: an app stored with a value the rule now refuses can still be updated
// as long as the value does not change; changing it to another bad value is refused.
func TestValidateNextAppEnvKeyPrefix_UpdateRatchets(t *testing.T) {
	if err := ValidateNextAppEnvKeyPrefix("shop", "web", envSpec("my app"), envSpec("my app")); err != nil {
		t.Fatalf("an unchanged stored value must pass on update: %v", err)
	}
	if err := ValidateNextAppEnvKeyPrefix("shop", "web", envSpec("shop"), envSpec("my app")); err == nil {
		t.Fatal("changing the value to a refused one must be refused")
	}
	if err := ValidateNextAppEnvKeyPrefix("shop", "web", envSpec("my app"), envSpec("shop")); err != nil {
		t.Fatalf("fixing a stored bad value must pass: %v", err)
	}
}

// The shared validator (and so the reconciler) does not apply the env rule.
func TestValidateNextAppSpec_DoesNotGateOnEnvKeyPrefix(t *testing.T) {
	spec := envSpec("my app")
	spec.Image = "r/a@sha256:" + strings.Repeat("a", 64)
	if err := ValidateNextAppSpec(spec); err != nil {
		t.Fatalf("ValidateNextAppSpec must not apply the ratcheted env rule: %v", err)
	}
}
