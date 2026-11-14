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
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/event"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

func zoneWith(gen int64, conds ...metav1.Condition) *appsv1alpha1.NextApp {
	app := &appsv1alpha1.NextApp{}
	app.Generation = gen
	app.Status.Conditions = conds
	return app
}

// #2501: the zone watch passes spec changes and ZoneSigningKey changes (the JWKS
// conflict clearing), and nothing else a status write does.
func TestZoneWatchPredicate(t *testing.T) {
	p := zoneWatchPredicate()
	key := func(status metav1.ConditionStatus, reason string) metav1.Condition {
		return metav1.Condition{Type: ConditionZoneSigningKey, Status: status, Reason: reason}
	}
	ready := metav1.Condition{Type: "Ready", Status: metav1.ConditionTrue, Reason: "A"}
	cases := []struct {
		name     string
		old, new *appsv1alpha1.NextApp
		want     bool
	}{
		{"a spec change", zoneWith(1), zoneWith(2), true},
		{"another condition changes", zoneWith(1, ready), zoneWith(1, metav1.Condition{Type: "Ready", Status: metav1.ConditionFalse, Reason: "B"}), false},
		{"nothing changes", zoneWith(1, key(metav1.ConditionTrue, ReasonSigningKeyActive)), zoneWith(1, key(metav1.ConditionTrue, ReasonSigningKeyActive)), false},
		{"the JWKS conflict clears", zoneWith(1, key(metav1.ConditionFalse, ReasonJWKSConfigMapConflict)), zoneWith(1, key(metav1.ConditionTrue, ReasonSigningKeyActive)), true},
		{"the reason alone changes", zoneWith(1, key(metav1.ConditionFalse, ReasonJWKSConfigMapConflict)), zoneWith(1, key(metav1.ConditionFalse, "Other")), true},
		{"the condition appears", zoneWith(1), zoneWith(1, key(metav1.ConditionTrue, ReasonSigningKeyActive)), true},
		{"the condition goes", zoneWith(1, key(metav1.ConditionTrue, ReasonSigningKeyActive)), zoneWith(1), true},
	}
	for _, c := range cases {
		if got := p.Update(event.UpdateEvent{ObjectOld: c.old, ObjectNew: c.new}); got != c.want {
			t.Errorf("%s: Update = %v, want %v", c.name, got, c.want)
		}
	}
	if !p.Create(event.CreateEvent{Object: zoneWith(1)}) || !p.Delete(event.DeleteEvent{Object: zoneWith(1)}) {
		t.Error("a zone created or deleted must pass")
	}
}
