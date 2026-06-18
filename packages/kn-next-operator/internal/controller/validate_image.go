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
	"fmt"
	"strings"
)

// validateImageRef enforces digest-pinning for all NextApp images.
//
// Acceptance rules (ADR-0001 / A1-digest):
//   - ACCEPT:  image contains "@sha256:" — digest-pinned (with or without a tag)
//   - REJECT:  image ends with ":latest" — mutable, prevents rollbacks
//   - REJECT:  image has no "@sha256:" suffix — tag-only refs are mutable
//   - REJECT:  image has no tag separator at all (implicitly :latest)
//
// This replaces the inline validation in Reconcile that only WARNED on :latest.
func validateImageRef(image string) error {
	// A digest-pinned image MUST contain "@sha256:" — accept immediately.
	if strings.Contains(image, "@sha256:") {
		return nil
	}

	// No "@sha256:" — image is either tagless (implicit :latest) or tag-only.
	// Both are rejected: tags are mutable and cannot guarantee provenance.

	if strings.HasSuffix(image, ":latest") {
		return fmt.Errorf(
			"image %q uses the :latest tag which is forbidden: "+
				"use a digest-pinned ref (e.g. myapp:v1@sha256:<hash>)",
			image,
		)
	}

	if !strings.Contains(image, ":") {
		// No tag separator at all — registry resolves to :latest.
		return fmt.Errorf(
			"image %q has no explicit tag or digest: "+
				"use a digest-pinned ref (e.g. myapp:v1@sha256:<hash>)",
			image,
		)
	}

	// Has a tag but no @sha256: — tag-only ref, still mutable.
	return fmt.Errorf(
		"image %q has a tag but no digest pin (@sha256:): "+
			"use a digest-pinned ref (e.g. %s@sha256:<hash>)",
		image, image,
	)
}
