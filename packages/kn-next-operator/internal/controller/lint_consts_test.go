package controller

// Shared string literals hoisted by the goconst lint.
const (
	lcAdmissionregistrationK8sIo = "admissionregistration.k8s.io"
	lcClusterRole                = "ClusterRole"
	lcConfigmaps                 = "configmaps"
	lcDynamic                    = "dynamic"
	lcEmulator                   = "emulator"
	lcKn5be479caf0c0             = "kn-5be479caf0c0"
	lcManagerRole                = "manager-role"
	lcProd                       = "prod"
	lcReconcile                  = "Reconcile"
	lcRemoveRendered             = "removeRendered"
	lcSecrets                    = "secrets"
	lcShop00001                  = "shop-00001"
	lcShop00002                  = "shop-00002"
	lcShop00003                  = "shop-00003"
	lcStripe                     = "stripe"
	lcV100                       = "1.0.0"
	lcV24116dd4a062              = "24116dd4a062"
)

// Package-level twins of the Describe-scoped fixtures of the same name; the
// scoped declarations shadow these where they exist.
const (
	validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
)

const otherNS = "team-a"
const lcTeamA = otherNS

const (
	lcConfigMap = "ConfigMap"
	lcSecret    = "Secret"
)
