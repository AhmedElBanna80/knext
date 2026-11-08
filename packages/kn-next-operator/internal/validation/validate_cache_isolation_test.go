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

func cacheSpec(c *appsv1alpha1.CacheSpec) *appsv1alpha1.NextAppSpec {
	return &appsv1alpha1.NextAppSpec{Image: digestImage, Cache: c}
}

func TestValidateCacheKeyPrefixReservedPlatformKeyspace(t *testing.T) {
	for _, p := range []string{"knext", "knext:cdn", "knext:"} {
		err := ValidateNextAppSpec(cacheSpec(&appsv1alpha1.CacheSpec{Provider: "redis", KeyPrefix: p}))
		if err == nil || !strings.Contains(err.Error(), "reserved") {
			t.Errorf("prefix %q must be refused as reserved, got %v", p, err)
		}
	}
	for _, p := range []string{"knext2", "knextual", "my-knext", "kn-next2", ""} {
		if err := ValidateNextAppSpec(cacheSpec(&appsv1alpha1.CacheSpec{Provider: "redis", KeyPrefix: p})); err != nil {
			t.Errorf("prefix %q must be accepted, got %v", p, err)
		}
	}
}

func TestValidateCacheIsolationEnum(t *testing.T) {
	for _, v := range []string{"", "auto", "acl", "none"} {
		if err := ValidateNextAppSpec(cacheSpec(&appsv1alpha1.CacheSpec{Provider: "redis", Isolation: v})); err != nil {
			t.Errorf("isolation %q must be accepted, got %v", v, err)
		}
	}
	err := ValidateNextAppSpec(cacheSpec(&appsv1alpha1.CacheSpec{Provider: "redis", Isolation: "strict"}))
	if err == nil || !strings.Contains(err.Error(), "isolation") {
		t.Errorf("an unknown isolation must be refused, got %v", err)
	}
}
