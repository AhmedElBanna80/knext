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
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"strings"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Per-app Redis ACL user (ADR-0071). This file is the pure half: names, the
// rule set, endpoint canonicalisation and the isolation decision. The I/O half
// is redis_acl_reconcile.go.

// Isolation modes of spec.cache.isolation.
const (
	cacheIsolationAuto = "auto"
	cacheIsolationACL  = "acl"
	cacheIsolationNone = "none"
)

// cacheIsolationMode is the resolved decision for one app.
type cacheIsolationMode int

const (
	// isolationShared: the app uses the credential in spec.cache.url.
	isolationShared cacheIsolationMode = iota
	// isolationACL: the app runs under its own ACL user.
	isolationACL
	// isolationRequiredUnavailable: isolation was requested (acl) and the
	// endpoint is not registered. Fail closed.
	isolationRequiredUnavailable
)

// resolveCacheIsolation decides the mode from spec.cache.isolation and whether
// the app's canonical endpoint is registered on the KnextPlatform.
func resolveCacheIsolation(isolation string, registered bool) cacheIsolationMode {
	switch isolation {
	case cacheIsolationNone:
		return isolationShared
	case cacheIsolationACL:
		if registered {
			return isolationACL
		}
		return isolationRequiredUnavailable
	default: // "", auto
		if registered {
			return isolationACL
		}
		return isolationShared
	}
}

// redisACLUsernamePrefix starts every user this operator family creates.
const redisACLUsernamePrefix = "knext-app-"

// redisCredentialsSecretKey is the key of the operator-owned Secret that holds
// the app's REDIS_URL.
const redisCredentialsSecretKey = "REDIS_URL"

// redisCredentialsSecretName is the operator-owned Secret an isolated app reads
// its REDIS_URL from.
func redisCredentialsSecretName(app *appsv1alpha1.NextApp) string {
	return RedisCredentialsSecretName(app.Name)
}

// RedisCredentialsSecretName is the Secret's name for one zone. The operator's
// write policy (config/admission/secret-configmap-writes.yaml) allows exactly
// this suffix.
func RedisCredentialsSecretName(zone string) string { return zone + "-redis-credentials" }

// redisClusterTag is the first 8 hex of sha256(<cluster identity>).
func redisClusterTag(clusterIdentity string) string {
	sum := sha256.Sum256([]byte(clusterIdentity))
	return hex.EncodeToString(sum[:])[:8]
}

// redisACLUsername is knext-app-<cluster tag>-<app hash>. The app hash is the
// one the default key prefix and the CDN tag prefix use, so the name is
// deterministic and does not expose the app's name.
func redisACLUsername(clusterIdentity string, app *appsv1alpha1.NextApp) string {
	return redisACLUsernamePrefix + redisClusterTag(clusterIdentity) + "-" + cdnTagPrefix(app)
}

// appRedisCommands is the exact command list granted to an app's user: the
// spike's measured minimal set (scripts/redis-acl-spike.mjs MINIMAL_COMMANDS)
// plus client|setinfo, which only labels the caller's own connection. INFO is
// deliberately absent. TestAppRedisCommandsMatchTheSpike keeps the two equal.
func appRedisCommands() []string {
	return []string{
		"get", "set", "del", "sadd", "smembers", "lpush", "ltrim", "lrange",
		"hget", "hset", "hdel", "hmget", "hscan", "scan", "eval", "time",
		"multi", "exec", "discard", "ping",
		"client|setinfo",
	}
}

// redisGlobEscape is the cleaner's escape, reused so the ACL key pattern and the
// finalizer's SCAN match agree byte for byte.
func redisGlobEscape(text string) string { return escapeRedisGlob(text) }

// redisACLRules builds the ACL SETUSER arguments after the username. It is a
// pure function of the app's identity, its spec and the Secret: the current
// password, plus the previous password's sha256 for as long as a rotation is in
// flight. cdnPrefix, when non-empty, adds the write-only claim-key selector.
func redisACLRules(prefix, password, previousSHA256, cdnPrefix string) []string {
	rules := []string{"reset", "on", ">" + password}
	if previousSHA256 != "" {
		rules = append(rules, "#"+previousSHA256)
	}
	rules = append(rules, "~"+redisGlobEscape(prefix)+":*")
	if cdnPrefix != "" {
		rules = append(rules, "%W~knext:cdn:purged:"+cdnPrefix+":*")
	}
	rules = append(rules, "resetchannels", "-@all")
	for _, c := range appRedisCommands() {
		rules = append(rules, "+"+c)
	}
	return rules
}

// redisURLHasUserinfo reports whether a Redis URL carries credentials.
func redisURLHasUserinfo(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.User != nil
}

// canonicalRedisEndpoint returns the one spelling of an in-cluster Redis
// endpoint, "<service>.<namespace>.svc.cluster.local:<port>", relative to the
// app's namespace (ADR-0071 D1a). A host that has no in-cluster Service form
// (an external DNS name, an IP) has no canonical form: it cannot be registered,
// so an app pointing at it is never provisioned.
func canonicalRedisEndpoint(raw, appNamespace string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse redis url: %w", err)
	}
	if u.Scheme != "redis" && u.Scheme != "rediss" {
		return "", fmt.Errorf("not a redis url (scheme %q)", u.Scheme)
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" {
		return "", fmt.Errorf("redis url has no host")
	}
	if net.ParseIP(host) != nil {
		return "", fmt.Errorf("an IP address has no canonical in-cluster endpoint")
	}
	port := u.Port()
	if port == "" {
		port = "6379"
	}
	const suffix = ".svc.cluster.local"
	labels := strings.Split(host, ".")
	switch {
	case strings.HasSuffix(host, suffix):
		if len(labels) != 5 {
			return "", fmt.Errorf("host %q is not <service>.<namespace>%s", host, suffix)
		}
	case len(labels) == 1:
		host = host + "." + appNamespace + suffix
	case len(labels) == 2:
		host += suffix
	case len(labels) == 3 && labels[2] == "svc":
		host += ".cluster.local"
	default:
		return "", fmt.Errorf("host %q is not an in-cluster Service name", host)
	}
	return host + ":" + port, nil
}

// appRedisURL is the URL an isolated app's pods connect with.
func appRedisURL(scheme, endpoint, username, password string) string {
	u := url.URL{Scheme: scheme, User: url.UserPassword(username, password), Host: endpoint}
	return u.String()
}
