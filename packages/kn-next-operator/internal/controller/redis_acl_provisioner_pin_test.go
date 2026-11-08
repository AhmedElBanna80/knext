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
	"context"
	"net/url"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// ADR-0071 D1: the provisioner credential is ENDPOINT-BOUND. The operator dials
// the registered endpoint, never the host as a Secret (or a CR author) spelled it.
// A Secret whose host is not the registered endpoint is refused, not followed.

func (h *aclHarness) setProvisionerURL(t *testing.T, raw string) {
	t.Helper()
	var sec corev1.Secret
	key := client.ObjectKey{Namespace: "operator-ns", Name: "redis-provisioner"}
	if err := h.c.Get(context.Background(), key, &sec); err != nil {
		t.Fatal(err)
	}
	sec.Data["url"] = []byte(raw)
	if err := h.c.Update(context.Background(), &sec); err != nil {
		t.Fatal(err)
	}
}

func (h *aclHarness) recordDials() *[]string {
	var dialed []string
	h.r.RedisDialer = func(_ context.Context, u string) (RedisProvisioner, error) {
		dialed = append(dialed, u)
		return h.prov, nil
	}
	return &dialed
}

func TestProvisionerIsPinnedToTheRegisteredEndpoint(t *testing.T) {
	refused := map[string]string{
		"an attacker's host":               "redis://provisioner:pw@attacker.example.com:6379",
		"another in-cluster Service":       "redis://provisioner:pw@other.cache.svc.cluster.local:6379",
		"the right host on another port":   "redis://provisioner:pw@redis.cache.svc.cluster.local:6380",
		"a bare name in the operator's ns": "redis://provisioner:pw@redis:6379",
		"an IP literal":                    "redis://provisioner:pw@10.0.0.4:6379",
		"a Secret value that is not a URL": "provisioner:pw@redis.cache.svc.cluster.local",
		"a URL with no host":               "redis://provisioner:pw@",
		"a non-redis scheme":               "http://provisioner:pw@redis.cache.svc.cluster.local:6379",
	}
	for name, raw := range refused {
		t.Run("refuses "+name, func(t *testing.T) {
			h := newACLHarness(t, true)
			h.setProvisionerURL(t, raw)
			dialed := h.recordDials()
			st, err := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
			if err != nil {
				t.Fatal(err)
			}
			if len(*dialed) != 0 {
				t.Fatalf("the operator dialled %v: the provisioner credential left for a host that is not the registered endpoint", *dialed)
			}
			if st.reason != ReasonCacheProvisionerRefused || !st.failClosed {
				t.Fatalf("must fail closed with %q: %+v", ReasonCacheProvisionerRefused, st)
			}
			if strings.Contains(st.message, "pw") || strings.Contains(st.message, "attacker") {
				t.Fatalf("the message echoes the Secret: %q", st.message)
			}
			if len(h.prov.users) != 0 {
				t.Fatal("a user was created")
			}
		})
	}
}

func TestProvisionerIsDialledAtTheRegisteredEndpointNotTheSecretsSpelling(t *testing.T) {
	// Spellings that canonicalise to the registered endpoint are accepted, and the
	// operator dials the registered form, byte for byte.
	for _, raw := range []string{
		"redis://provisioner:pw@redis.cache.svc.cluster.local:6379",
		"redis://provisioner:pw@redis.cache.svc:6379",
		"redis://provisioner:pw@redis.cache:6379",
		"redis://provisioner:pw@Redis.Cache.SVC.cluster.local.:6379",
		"redis://provisioner:pw@redis.cache.svc.cluster.local",
	} {
		t.Run(raw, func(t *testing.T) {
			h := newACLHarness(t, true)
			h.setProvisionerURL(t, raw)
			dialed := h.recordDials()
			st, err := h.r.reconcileCacheCredentials(context.Background(), aclApp("shop", "web", "shop-web", ""), h.snap)
			if err != nil || !st.ready {
				t.Fatalf("state=%+v err=%v", st, err)
			}
			if len(*dialed) == 0 {
				t.Fatal("never dialled")
			}
			for _, d := range *dialed {
				u, perr := url.Parse(d)
				if perr != nil {
					t.Fatal(perr)
				}
				if u.Host != aclTestEndpoint {
					t.Fatalf("dialled host %q, want exactly the registered %q", u.Host, aclTestEndpoint)
				}
				if pw, _ := u.User.Password(); u.User.Username() != "provisioner" || pw != "pw" {
					t.Fatalf("the provisioner credential was altered: %q", d)
				}
			}
		})
	}
}

// The finalizer dials through the same path.
func TestFinalizerDialsThePinnedEndpointToo(t *testing.T) {
	h := newACLHarness(t, true)
	app := aclApp("shop", "web", "shop-web", "")
	provisioned(t, h, app)
	h.setProvisionerURL(t, "redis://provisioner:pw@attacker.example.com:6379")
	dialed := h.recordDials()
	h.finalize(t, app)
	if len(*dialed) != 0 {
		t.Fatalf("the finalizer dialled %v", *dialed)
	}
}
