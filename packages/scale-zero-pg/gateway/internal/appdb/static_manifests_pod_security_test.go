package appdb

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/yaml"
)

// POD SECURITY `restricted` ON THE STATIC BASE-TIER COMPUTE MANIFESTS.
//
// deploy/20-compute.yaml (cold writer), 25-compute-warm.yaml (warm writer) and
// 26-compute-ro.yaml (base read pool) are applied as-is, so they must meet the
// same profile, field for field, as the operator-rendered per-app compute pods
// (see render_pod_security_test.go): every init container and every container,
// checked field by field AND by the Kubernetes pod-security-admission evaluator.
// The images name their user (postgres / neon, uid 1000:1000 in the pinned
// digests; see image_uid_table_test.go), so the numeric ids are required.

var staticComputeManifests = []string{"20-compute.yaml", "25-compute-warm.yaml", "26-compute-ro.yaml"}

func parseStaticDeployments(t *testing.T, file string) []*appsv1.Deployment {
	t.Helper()
	path := filepath.Join("..", "..", "..", "deploy", file)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read %s: %v", path, err)
	}
	var out []*appsv1.Deployment
	for _, doc := range strings.Split(string(raw), "\n---") {
		if strings.TrimSpace(doc) == "" {
			continue
		}
		var head struct {
			Kind string `json:"kind"`
		}
		if err := yaml.Unmarshal([]byte(doc), &head); err != nil {
			t.Fatalf("%s: unparseable document: %v", file, err)
		}
		if head.Kind != "Deployment" {
			continue
		}
		var d appsv1.Deployment
		if err := yaml.UnmarshalStrict([]byte(doc), &d); err != nil {
			t.Fatalf("%s: Deployment does not parse strictly: %v", file, err)
		}
		out = append(out, &d)
	}
	return out
}

func TestStaticComputeManifestsMeetPodSecurityRestricted(t *testing.T) {
	for _, file := range staticComputeManifests {
		t.Run(file, func(t *testing.T) {
			deps := parseStaticDeployments(t, file)
			if len(deps) != 1 {
				t.Fatalf("%s: found %d Deployments, want 1 (the guard would pass vacuously otherwise)", file, len(deps))
			}
			spec := &deps[0].Spec.Template.Spec
			if len(spec.InitContainers) == 0 || len(spec.Containers) == 0 {
				t.Fatalf("%s has %d init / %d main containers; the guard would pass vacuously", file, len(spec.InitContainers), len(spec.Containers))
			}
			for _, c := range append(append([]corev1.Container{}, spec.InitContainers...), spec.Containers...) {
				requireContainerRestricted(t, c)
			}
			if v := restrictedViolations(t, spec); len(v) != 0 {
				t.Fatalf("%s fails Pod Security restricted:\n  - %s", file, strings.Join(v, "\n  - "))
			}
		})
	}
}
