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
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

func aclTestApp(ns, name string) *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{Namespace: ns, Name: name}
}

func TestCanonicalRedisEndpoint(t *testing.T) {
	cases := []struct {
		name, url, ns, want string
		wantErr             bool
	}{
		{"fqdn", "redis://redis.cache.svc.cluster.local:6379", "shop", "redis.cache.svc.cluster.local:6379", false},
		{"default port", "redis://redis.cache.svc.cluster.local", "shop", "redis.cache.svc.cluster.local:6379", false},
		{"svc.ns", "redis://redis.cache:6379", "shop", "redis.cache.svc.cluster.local:6379", false},
		{"svc.ns.svc", "redis://redis.cache.svc:6379", "shop", "redis.cache.svc.cluster.local:6379", false},
		{"bare service is relative to the app namespace", "redis://redis:6379", "shop", "redis.shop.svc.cluster.local:6379", false},
		{"case and trailing dot", "redis://Redis.Cache.svc.cluster.local.:6379", "shop", "redis.cache.svc.cluster.local:6379", false},
		{"userinfo does not change the endpoint", "redis://u:p@redis.cache.svc.cluster.local:6379/0", "shop", "redis.cache.svc.cluster.local:6379", false},
		{"rediss scheme", "rediss://redis.cache.svc.cluster.local:6380", "shop", "redis.cache.svc.cluster.local:6380", false},
		{"an external host has no canonical in-cluster form", "redis://cache.example.com:6379", "shop", "", true},
		{"an IP has no canonical form", "redis://10.0.0.4:6379", "shop", "", true},
		{"not a redis url", "http://redis.cache.svc.cluster.local", "shop", "", true},
		{"empty", "", "shop", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := canonicalRedisEndpoint(tc.url, tc.ns)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRedisURLHasUserinfo(t *testing.T) {
	if !redisURLHasUserinfo("redis://u:p@h:6379") || !redisURLHasUserinfo("redis://:p@h:6379") {
		t.Fatal("userinfo not detected")
	}
	if redisURLHasUserinfo("redis://h:6379/0") {
		t.Fatal("false positive")
	}
}

func TestRedisACLUsernameIsClusterTaggedAndDoesNotExposeTheApp(t *testing.T) {
	app := aclTestApp("shop", "web")
	u := redisACLUsername("kube-uid-1", app)
	if !regexp.MustCompile(`^knext-app-[0-9a-f]{8}-[0-9a-f]{12}$`).MatchString(u) {
		t.Fatalf("username %q has the wrong shape", u)
	}
	if strings.Contains(u, "shop") || strings.Contains(u, "web") {
		t.Fatalf("username %q exposes the app name", u)
	}
	if u != redisACLUsername("kube-uid-1", app) {
		t.Fatal("not deterministic")
	}
	if u == redisACLUsername("kube-uid-2", app) {
		t.Fatal("two clusters must not derive the same user for the same app")
	}
	if u == redisACLUsername("kube-uid-1", aclTestApp("shop", "api")) {
		t.Fatal("two apps must not share a user")
	}
	// The app hash is the one the default prefix and the CDN tag prefix use.
	if !strings.HasSuffix(u, "-"+cdnTagPrefix(app)) {
		t.Fatalf("username %q does not end in the CDN tag prefix %q", u, cdnTagPrefix(app))
	}
}

func TestRedisACLRulesShape(t *testing.T) {
	rules := redisACLRules("kn-abc", "pw", "", "")
	joined := strings.Join(rules, " ")
	for _, want := range []string{"reset", "on", ">pw", "~kn-abc:*", "resetchannels", "-@all", "+get", "+eval", "+time", "+client|setinfo"} {
		if !contains(rules, want) {
			t.Errorf("rules %q lack %q", joined, want)
		}
	}
	// Order matters to Redis: reset first, deny-all before the allowlist.
	if rules[0] != "reset" || indexOf(rules, "-@all") > indexOf(rules, "+get") {
		t.Errorf("rules out of order: %q", joined)
	}
	for _, banned := range []string{"+info", "+@all", "allkeys", "~*", "allcommands", "&*", "+flushall", "+acl"} {
		if contains(rules, banned) {
			t.Errorf("rules %q grant %q", joined, banned)
		}
	}
	if strings.Contains(joined, "%W~") {
		t.Errorf("no CDN configured, yet rules carry a write-only selector: %q", joined)
	}
}

func TestRedisACLRulesEscapeThePrefixGlob(t *testing.T) {
	rules := redisACLRules("a*b[c]", "pw", "", "")
	if !contains(rules, `~a\*b\[c\]:*`) {
		t.Fatalf("prefix not glob-escaped: %q", rules)
	}
}

func TestRedisACLRulesCDNClaimKeyIsWriteOnly(t *testing.T) {
	rules := redisACLRules("kn-abc", "pw", "", "0123456789ab")
	if !contains(rules, "%W~knext:cdn:purged:0123456789ab:*") {
		t.Fatalf("CDN claim selector missing: %q", rules)
	}
}

func TestRedisACLRulesDuringRotationCarryBothPasswords(t *testing.T) {
	rules := redisACLRules("kn-abc", "new", "deadbeef", "")
	if !contains(rules, ">new") || !contains(rules, "#deadbeef") {
		t.Fatalf("a mid-rotation re-assert must carry both credentials: %q", rules)
	}
}

// The operator's command list and the spike's must not drift: the spike is what
// the live Redis lane measures, the operator is what grants.
func TestAppRedisCommandsMatchTheSpike(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "scripts", "redis-acl-spike.mjs"))
	if err != nil {
		t.Fatalf("read spike: %v", err)
	}
	m := regexp.MustCompile(`(?s)export const MINIMAL_COMMANDS = Object\.freeze\(\[(.*?)\]\)`).FindSubmatch(src)
	if m == nil {
		t.Fatal("MINIMAL_COMMANDS not found in scripts/redis-acl-spike.mjs")
	}
	var spike []string
	for _, c := range regexp.MustCompile(`'([a-z|]+)'`).FindAllSubmatch(m[1], -1) {
		spike = append(spike, string(c[1]))
	}
	// The ADR adds exactly one command to the spike's measured set.
	want := append(append([]string{}, spike...), "client|setinfo")
	got := appRedisCommands()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("operator commands drifted from the spike:\n operator %v\n spike+ADR %v", got, want)
	}
	if len(spike) < 20 {
		t.Fatalf("parsed only %d spike commands; the regexp is stale", len(spike))
	}
}

func TestResolveCacheIsolation(t *testing.T) {
	cases := []struct {
		isolation  string
		registered bool
		want       cacheIsolationMode
	}{
		{"", true, isolationACL},
		{"auto", true, isolationACL},
		{"auto", false, isolationShared},
		{"", false, isolationShared},
		{"acl", true, isolationACL},
		{"acl", false, isolationRequiredUnavailable},
		{"none", true, isolationShared},
		{"none", false, isolationShared},
	}
	for _, tc := range cases {
		if got := resolveCacheIsolation(tc.isolation, tc.registered); got != tc.want {
			t.Errorf("isolation=%q registered=%v: got %v, want %v", tc.isolation, tc.registered, got, tc.want)
		}
	}
}

func contains(xs []string, x string) bool { return indexOf(xs, x) >= 0 }

func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
}
