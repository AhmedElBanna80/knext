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
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// validateImageRef enforces digest-pinning for all NextApp images.
//
// The digest-pinning logic now lives in internal/validation so the admission
// webhook and the reconciler share a single implementation and cannot drift.
// This thin wrapper is retained for the reconciler's existing call sites and
// tests; it delegates to validation.ValidateImageRef.
func validateImageRef(image string) error {
	return validation.ValidateImageRef(image)
}
