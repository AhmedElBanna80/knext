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

// ADR-0071 D6a rules 0 and 1. The vector below is sha256("shop/web")[:12],
// computed independently of the code under test.
const shopWebDerived = "kn-97375646b1de"

func TestDerivedCacheKeyPrefixVector(t *testing.T) {
	if got := DerivedCacheKeyPrefix("shop", "web"); got != shopWebDerived {
		t.Fatalf("DerivedCacheKeyPrefix(shop, web) = %q, want %q", got, shopWebDerived)
	}
	if DerivedCacheKeyPrefix("shop", "web") == DerivedCacheKeyPrefix("shop", "api") {
		t.Fatal("two apps must not derive one prefix")
	}
}

func TestCacheKeyPrefixViolation(t *testing.T) {
	cases := []struct {
		name, ns, app, prefix string
		refused               bool
	}{
		{"the platform keyspace", "shop", "web", "knext", true},
		{"under the platform keyspace", "shop", "web", "knext:cdn:purged", true},
		{"another app's derived prefix", "evil", "app", shopWebDerived, true},
		{"a nesting under another app's derived prefix", "evil", "app", shopWebDerived + ":isr", true},
		{"a nesting with an empty remainder", "evil", "app", shopWebDerived + ":", true},
		{"a nesting that carries a newline", "evil", "app", shopWebDerived + ":a\nb", true},
		{"a nesting under the app's own derived prefix", "shop", "web", shopWebDerived + ":isr", true},
		{"the app's own derived prefix", "shop", "web", shopWebDerived, false},
		{"an ordinary prefix", "shop", "web", "shop-web", false},
		{"13 hex digits", "evil", "app", "kn-97375646b1dea", false},
		{"11 hex digits", "evil", "app", "kn-97375646b1d", false},
		{"upper-case hex", "evil", "app", "kn-97375646B1DE", false},
		{"knext with other text before it", "shop", "web", "app:knext:x", false},
		{"KNEXT is a different keyspace", "shop", "web", "KNEXT:x", false},
		{"knextual", "shop", "web", "knextual", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := CacheKeyPrefixViolation(tc.ns, tc.app, tc.prefix)
			if (got != "") != tc.refused {
				t.Fatalf("CacheKeyPrefixViolation(%q, %q, %q) = %q, refused want %v", tc.ns, tc.app, tc.prefix, got, tc.refused)
			}
			if tc.refused && !strings.Contains(got, "keyPrefix") {
				t.Fatalf("the reason must name the field: %q", got)
			}
		})
	}
}

func TestValidateNextAppCacheKeyPrefix(t *testing.T) {
	spec := func(p string) *appsv1alpha1.NextAppSpec {
		return &appsv1alpha1.NextAppSpec{Cache: &appsv1alpha1.CacheSpec{Provider: "redis", KeyPrefix: p}}
	}
	if err := ValidateNextAppCacheKeyPrefix("evil", "app", spec(shopWebDerived+":isr")); err == nil ||
		!strings.Contains(err.Error(), "spec.cache.keyPrefix") {
		t.Fatalf("the squat must be refused, naming the field, got %v", err)
	}
	for _, ok := range []*appsv1alpha1.NextAppSpec{spec(""), spec("shop-web"), {}, nil} {
		if err := ValidateNextAppCacheKeyPrefix("evil", "app", ok); err != nil {
			t.Fatalf("must be accepted, got %v", err)
		}
	}
}
