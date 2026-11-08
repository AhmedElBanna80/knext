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
	"slices"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// #2423: an unparseable spec.resources quantity is a refusal decided from the
// spec, reported as Ready=False InvalidSpec, not a reconcile error retried on
// backoff with nothing in status.

func invalidSpecObservation() functionObservation {
	o := acceptedObservation(zoneJWKSControlled, "")
	o.invalidSpec = `spec.resources.cpuRequest "lots" is not a valid Kubernetes quantity: quantities must match the regular expression`
	return o
}

func TestAnInvalidSpecIsNotAccepted(t *testing.T) {
	if !acceptedObservation(zoneJWKSControlled, "").accepted() {
		t.Fatal("control: the clean observation must be accepted")
	}
	if invalidSpecObservation().accepted() {
		t.Fatal("a function whose spec cannot be rendered must not be accepted: nothing may render or mount")
	}
}

func TestVerdictForAnInvalidSpecIsInvalidSpec(t *testing.T) {
	v := computeBackendServiceVerdict(jwksBS(), invalidSpecObservation())
	ready := verdictCondition(t, v, ConditionReady)
	if ready.Status != metav1.ConditionFalse || ready.Reason != ReasonInvalidSpec {
		t.Fatalf("Ready = %s/%s, want False/%s", ready.Status, ready.Reason, ReasonInvalidSpec)
	}
	if !strings.Contains(ready.Message, "spec.resources.cpuRequest") {
		t.Errorf("Ready must name the bad field: %q", ready.Message)
	}
	if v.refusal != ReasonInvalidSpec {
		t.Errorf("a function newly entering the refusal must be counted as one: refusal = %q", v.refusal)
	}
	if len(v.events) == 0 {
		t.Error("the refusal must raise a Warning event")
	}
}

func TestAnInvalidImageStillWinsOverAnInvalidSpec(t *testing.T) {
	o := invalidSpecObservation()
	o.invalidImage = "spec.image is refused: not pinned"
	ready := verdictCondition(t, computeBackendServiceVerdict(jwksBS(), o), ConditionReady)
	if ready.Reason != ReasonInvalidImage {
		t.Fatalf("Ready reason = %s, want %s (the image is reported first)", ready.Reason, ReasonInvalidImage)
	}
}

func TestInvalidSpecIsCountedUnderItsOwnReason(t *testing.T) {
	if !slices.Contains(backendServiceRefusalReasons, ReasonInvalidSpec) {
		t.Fatalf("knext_backendservice_refusals_total must carry %s: %v", ReasonInvalidSpec, backendServiceRefusalReasons)
	}
}
