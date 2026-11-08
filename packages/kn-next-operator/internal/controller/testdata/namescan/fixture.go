// Package namescan is a fixture for the write-inventory scanner's name
// detection. It is loaded by the scanner test, never built into the operator.
package namescan

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func nameHelper(zone string) string { return zone + "-x" }

func classicNamed() *corev1.Secret {
	return &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: nameHelper("z"), Namespace: "ns"}}
}

func flatNamed() *corev1.Secret {
	return &corev1.Secret{Name: nameHelper("z"), Namespace: "ns"}
}

func classicNameless() *corev1.Secret {
	return &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Namespace: "ns"}}
}

func flatNameless() *corev1.Secret {
	return &corev1.Secret{Namespace: "ns"}
}

func flatLiteralName() *corev1.ConfigMap {
	return &corev1.ConfigMap{Name: "hardcoded"}
}

// decoy has a Name field, but the type does not embed ObjectMeta: it names no
// object and must not be counted as one.
func decoy() *corev1.ConfigMapVolumeSource {
	return &corev1.ConfigMapVolumeSource{Name: nameHelper("z")}
}
