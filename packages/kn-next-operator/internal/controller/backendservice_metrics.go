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
	"github.com/prometheus/client_golang/prometheus"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

// Zone-function (BackendService) metrics. Labelled by result or reason, never
// per object.
//
// REGISTERED UNCONDITIONALLY, at top level in init(): the series exist (at 0)
// whether or not the BackendService CRD is installed and whether or not the
// controller runs, so an alert sees a real 0, never an absent series that
// reads as "fine". A registration under a condition would make the metric
// contract golden claim a family the binary does not always serve.
var (
	// backendServiceReconcileTotal counts BackendService reconcile loops by result.
	backendServiceReconcileTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "knext_backendservice_reconcile_total",
			Help: "Total number of BackendService (zone function) reconcile loops, labeled by result (success | error).",
		},
		[]string{"result"},
	)

	// backendServiceRefusalsTotal counts transitions INTO a refusal, by reason: a
	// function the operator would not render (zone missing, binding not
	// consented, an image or a spec other than the one the zone pinned, a conflicting owner, a credential-allowlist violation, an
	// unpinned image, a name another object controls), or would render only
	// without its zone's JWKS (a ConfigMap the zone does not control holds the
	// name).
	backendServiceRefusalsTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "knext_backendservice_refusals_total",
			Help: "Total number of times a BackendService entered a refused state, labeled by reason " +
				"(ZoneNotFound | ZoneNotListed | BindingImageMismatch | BindingSpecMismatch | ConflictingOwner | SovereigntyViolation | InvalidImage | InvalidSpec | KnativeServiceNameTaken | JWKSUntrusted).",
		},
		[]string{labelReason},
	)

	// backendServiceSecretsUnverifiedSince is one series per function currently
	// held in SovereigntyCompliant=Unknown/SecretsUnverified, valued at the unix
	// time the hold started, so an alert reads the duration as
	// time() - value. reason: transient (held without limit) | forbidden (held
	// for 10 minutes, then the function is refused and removed). No series means
	// verified; a deleted function's series is removed.
	backendServiceSecretsUnverifiedSince = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "knext_backendservice_secrets_unverified_since_timestamp_seconds",
			Help: "Unix time since which a BackendService has been held as SecretsUnverified (the operator cannot read " +
				"a referenced Secret), labeled by namespace, name and reason (transient | forbidden). Absent when verified.",
		},
		[]string{"namespace", "name", labelReason},
	)
)

// setUnverifiedGauge publishes (or, with nil, clears) a function's unverified
// series. It always drops the other reason's series first, so a transient hold
// that becomes a denial replaces its series rather than doubling it.
func setUnverifiedGauge(namespace, name string, rep *unverifiedReport) {
	for _, reason := range []string{unverifiedReasonTransient, unverifiedReasonForbidden} {
		backendServiceSecretsUnverifiedSince.DeleteLabelValues(namespace, name, reason)
	}
	if rep != nil {
		backendServiceSecretsUnverifiedSince.WithLabelValues(namespace, name, rep.reason).Set(float64(rep.since.Unix()))
	}
}

// backendServiceRefusalReasons is every reason the refusals counter carries.
var backendServiceRefusalReasons = []string{
	ReasonZoneNotFound, ReasonZoneNotListed, ReasonBindingImageMismatch, ReasonBindingSpecMismatch, ReasonConflictingOwner,
	ReasonSovereigntyViolation, ReasonInvalidImage, ReasonInvalidSpec, ReasonKnativeServiceNameTaken, ReasonJWKSUntrusted,
}

func init() {
	metrics.Registry.MustRegister(backendServiceReconcileTotal, backendServiceRefusalsTotal, backendServiceSecretsUnverifiedSince)
	for _, result := range []string{"success", "error"} {
		backendServiceReconcileTotal.WithLabelValues(result).Add(0)
	}
	for _, reason := range backendServiceRefusalReasons {
		backendServiceRefusalsTotal.WithLabelValues(reason).Add(0)
	}
}
