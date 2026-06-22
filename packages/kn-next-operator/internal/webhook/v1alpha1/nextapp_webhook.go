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

// Package v1alpha1 contains the validating admission webhook for the NextApp
// custom resource. It rejects invalid NextApps at write time, before the API
// server persists them — defense-in-depth on top of the reconciler's
// fail-closed validation. Webhook and reconciler share a single validation
// function (internal/validation.ValidateNextAppSpec) so they cannot drift.
package v1alpha1

import (
	"context"

	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// nextAppLog is for logging in this package.
var nextAppLog = logf.Log.WithName("nextapp-webhook")

// SetupNextAppWebhookWithManager registers the validating webhook for the
// NextApp resource with the manager.
func SetupNextAppWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr, &appsv1alpha1.NextApp{}).
		WithValidator(&NextAppCustomValidator{}).
		Complete()
}

// +kubebuilder:webhook:path=/validate-apps-kn-next-dev-v1alpha1-nextapp,mutating=false,failurePolicy=fail,sideEffects=None,groups=apps.kn-next.dev,resources=nextapps,verbs=create;update,versions=v1alpha1,name=vnextapp-v1alpha1.kb.io,admissionReviewVersions=v1

// NextAppCustomValidator validates NextApp resources at admission time. It
// implements admission.Validator[*NextApp] and delegates to the shared
// validation.ValidateNextAppSpec so admission and reconcile cannot diverge.
type NextAppCustomValidator struct{}

var _ admission.Validator[*appsv1alpha1.NextApp] = &NextAppCustomValidator{}

// ValidateCreate validates the spec when a NextApp is created.
func (v *NextAppCustomValidator) ValidateCreate(_ context.Context, nextApp *appsv1alpha1.NextApp) (admission.Warnings, error) {
	nextAppLog.Info("Validating NextApp on create", "name", nextApp.GetName())
	return nil, validation.ValidateNextAppSpec(&nextApp.Spec)
}

// ValidateUpdate validates the spec when a NextApp is updated.
func (v *NextAppCustomValidator) ValidateUpdate(_ context.Context, _, newApp *appsv1alpha1.NextApp) (admission.Warnings, error) {
	nextAppLog.Info("Validating NextApp on update", "name", newApp.GetName())
	return nil, validation.ValidateNextAppSpec(&newApp.Spec)
}

// ValidateDelete is a no-op: deletes are always allowed.
func (v *NextAppCustomValidator) ValidateDelete(_ context.Context, _ *appsv1alpha1.NextApp) (admission.Warnings, error) {
	return nil, nil
}
