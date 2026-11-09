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
	"reflect"
	"regexp"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The zone's backends[].httpVersion reaches the zone as
// <NAME>_SERVICE_HTTP_VERSION through the real reconcile render, and only when
// set (#2422). It is the zone's choice: nothing on the BackendService sets it.
func TestZoneEntryHTTPVersionRendersIntoTheZone(t *testing.T) {
	bs := &appsv1alpha1.BackendService{
		Name: "pricing", Namespace: "default",
		Spec: appsv1alpha1.BackendServiceSpec{Zone: sovZone, Image: imageA, WakeAhead: new(true)},
	}
	render := func(entry appsv1alpha1.BackendBinding) string {
		app := &appsv1alpha1.NextApp{
			Name: sovZone, Namespace: "default", Generation: 1,
			Spec: appsv1alpha1.NextAppSpec{
				Image:    "registry.example.com/app:v1@sha256:" + pinDigestA,
				Backends: []appsv1alpha1.BackendBinding{entry},
			},
		}
		return renderZoneKnativeService(t, app, bs)
	}
	plain := render(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
	if strings.Contains(plain, "PRICING_SERVICE_HTTP_VERSION") {
		t.Fatalf("unset httpVersion must render nothing:\n%s", plain)
	}
	for _, v := range []string{"1.1", "2"} {
		got := render(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing", HTTPVersion: v})
		want := regexp.MustCompile(`name: PRICING_SERVICE_HTTP_VERSION\s+value: ["']?` + regexp.QuoteMeta(v) + `["']?\n`)
		if !want.MatchString(got) {
			t.Fatalf("httpVersion %q did not render:\n%s", v, got)
		}
	}
}

// A zone that already sets the variable in spec.env keeps its own value; the
// binding variable is skipped and reported, never overwritten.
func TestHTTPVersionCollisionKeepsTheZoneValue(t *testing.T) {
	existing := []corev1.EnvVar{{Name: "ORDERS_SERVICE_HTTP_VERSION", Value: "2"}}
	b := zoneBindings{entries: []zoneBinding{
		{name: "orders", service: "orders-fn", state: bindingBound, httpVersion: "1.1"},
	}}
	got := renderBindingEnv(sovNS, existing, b)
	if envValue(got.env, "ORDERS_SERVICE_HTTP_VERSION") != "" {
		t.Fatalf("a colliding variable was rendered over the zone's own entry: %v", got.env)
	}
	if want := []string{"ORDERS_SERVICE_HTTP_VERSION"}; !reflect.DeepEqual(got.collisions, want) {
		t.Fatalf("collisions = %v, want %v", got.collisions, want)
	}
}
