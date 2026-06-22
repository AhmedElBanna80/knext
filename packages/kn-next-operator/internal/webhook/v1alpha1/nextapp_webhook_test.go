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

package v1alpha1

import (
	"context"
	"strings"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

const digestImage = "registry.example.com/app:v1@sha256:abc123def456"

func newNextApp(spec appsv1alpha1.NextAppSpec) *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{Spec: spec}
}

func TestValidateCreate(t *testing.T) {
	v := &NextAppCustomValidator{}
	ctx := context.Background()

	tests := []struct {
		name    string
		obj     *appsv1alpha1.NextApp
		wantErr bool
	}{
		{
			name:    "latest image rejected",
			obj:     newNextApp(appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:latest"}),
			wantErr: true,
		},
		{
			name:    "missing image rejected",
			obj:     newNextApp(appsv1alpha1.NextAppSpec{Image: ""}),
			wantErr: true,
		},
		{
			name: "minScale > maxScale rejected",
			obj: newNextApp(appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 5, MaxScale: 1},
			}),
			wantErr: true,
		},
		{
			name:    "valid digest-pinned accepted",
			obj:     newNextApp(appsv1alpha1.NextAppSpec{Image: digestImage}),
			wantErr: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := v.ValidateCreate(ctx, tc.obj)
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateCreate() err=%v, wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

func TestValidateUpdate(t *testing.T) {
	v := &NextAppCustomValidator{}
	ctx := context.Background()

	old := newNextApp(appsv1alpha1.NextAppSpec{Image: digestImage})

	// Updating to a :latest image must be rejected.
	bad := newNextApp(appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:latest"})
	if _, err := v.ValidateUpdate(ctx, old, bad); err == nil {
		t.Fatalf("ValidateUpdate() to :latest image = nil; want error")
	} else if !strings.Contains(err.Error(), ":latest") {
		t.Fatalf("ValidateUpdate() err=%v, want :latest message", err)
	}

	// Updating to another valid digest-pinned image is allowed.
	good := newNextApp(appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:v2@sha256:deadbeef"})
	if _, err := v.ValidateUpdate(ctx, old, good); err != nil {
		t.Fatalf("ValidateUpdate() valid = %v; want nil", err)
	}
}

func TestValidateDeleteIsNoOp(t *testing.T) {
	v := &NextAppCustomValidator{}
	// Even an invalid spec must be deletable.
	bad := newNextApp(appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:latest"})
	if _, err := v.ValidateDelete(context.Background(), bad); err != nil {
		t.Fatalf("ValidateDelete() = %v; want nil (no-op)", err)
	}
}
