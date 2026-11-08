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

package validation

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Reserved Redis key prefixes (ADR-0071 D6a rules 0 and 1). One definition, used by
// the admission webhook and by the reconciler, so the two cannot drift.

// derivedCachePrefixShape is the shape of a derived key prefix, and of anything
// nested under one: kn-<12 hex>, optionally followed by ':' and more. (?s) so a
// newline in the remainder cannot step outside it.
var derivedCachePrefixShape = regexp.MustCompile(`(?s)^kn-[0-9a-f]{12}(:.*)?$`)

// DerivedCacheKeyPrefix is the key prefix of an app that sets none: "kn-" plus the
// first 12 lowercase hex of sha256("<namespace>/<name>"). It is predictable from a
// victim's namespace and name, which is why the shape is reserved.
func DerivedCacheKeyPrefix(namespace, name string) string {
	sum := sha256.Sum256([]byte(namespace + "/" + name))
	return "kn-" + hex.EncodeToString(sum[:])[:12]
}

// IsPlatformKeyspace reports whether a key prefix is the platform keyspace: keys
// under "knext:" are shared across apps by design (every CDN app writes its
// first-ready claim key there), so no app may own it. Redis keys are
// case-sensitive, and the pattern is anchored at the start of the key.
func IsPlatformKeyspace(prefix string) bool {
	return prefix == "knext" || strings.HasPrefix(prefix, "knext:")
}

// CacheKeyPrefixViolation says why app <namespace>/<name> may not use the explicit
// key prefix, or "" when it may. It is the whole of ADR-0071 D6a rules 0 and 1:
//
//   - the platform keyspace (knext, knext:...) belongs to no app;
//   - the derived shape (kn-<12 hex>, and anything nested under it) belongs to the
//     app it derives from. Only the prefix EQUAL to the app's own derived prefix is
//     allowed: a nesting such as kn-<victim>:isr is issued ~kn-<victim>:isr:*, which
//     is the victim's ISR keys.
func CacheKeyPrefixViolation(namespace, name, prefix string) string {
	if IsPlatformKeyspace(prefix) {
		return fmt.Sprintf("keyPrefix %q is reserved for the platform keyspace", prefix)
	}
	if derivedCachePrefixShape.MatchString(prefix) && prefix != DerivedCacheKeyPrefix(namespace, name) {
		return fmt.Sprintf("keyPrefix %q is in the range derived for apps from their namespace and name and is not this app's own", prefix)
	}
	return ""
}

// ValidateNextAppCacheKeyPrefix is the admission half of CacheKeyPrefixViolation
// for spec.cache.keyPrefix. It needs the object's namespace and name, which the
// shared spec validator does not see, so the webhook calls it next to that
// validator.
func ValidateNextAppCacheKeyPrefix(namespace, name string, spec *appsv1alpha1.NextAppSpec) error {
	if spec == nil || spec.Cache == nil || spec.Cache.KeyPrefix == "" {
		return nil
	}
	if why := CacheKeyPrefixViolation(namespace, name, spec.Cache.KeyPrefix); why != "" {
		return fmt.Errorf("spec.cache.%s", why)
	}
	return nil
}

// EnvRedisKeyPrefix is the env var the runtime reads its Redis key prefix from.
const EnvRedisKeyPrefix = "REDIS_KEY_PREFIX"

// keyPrefixMaxRunes and keyPrefixForbidden mirror the CRD's structural rules on
// spec.cache.keyPrefix (MaxLength=63, Pattern ^[^*?\[\]\\ \t\n\r\f\v]*$).
const keyPrefixMaxRunes = 63

var keyPrefixForbidden = regexp.MustCompile(`[*?\[\]\\ \t\n\r\f\v]`)

// EnvKeyPrefixViolation says why app <namespace>/<name> may not set REDIS_KEY_PREFIX
// to v through spec.env (#2451), or "" when it may. It applies spec.cache.keyPrefix's
// structural rules (at most 63 code points, no whitespace or Redis glob characters)
// and CacheKeyPrefixViolation (the platform keyspace, another app's derived
// prefix). Unlike spec.cache.keyPrefix, the shared fallback keyspace kn-next is
// allowed: pinning REDIS_KEY_PREFIX to it is the documented way to keep the warm
// cache through the operator upgrade that introduced per-app prefixes. An empty
// value is unset.
func EnvKeyPrefixViolation(namespace, name, v string) string {
	switch {
	case v == "":
		return ""
	case utf8.RuneCountInString(v) > keyPrefixMaxRunes:
		return fmt.Sprintf("is longer than %d characters", keyPrefixMaxRunes)
	case keyPrefixForbidden.MatchString(v):
		return "contains whitespace or a Redis glob character (* ? [ ] \\)"
	}
	return CacheKeyPrefixViolation(namespace, name, v)
}

// ValidateNextAppEnvKeyPrefix is the admission check for spec.env[REDIS_KEY_PREFIX]
// (EnvKeyPrefixViolation). It is RATCHETED like the CRD's own rules: on update
// (old != nil) a value that did not change passes, so an app stored before the
// rule existed can still take unrelated updates such as an image bump. The
// reconciler does not apply it.
func ValidateNextAppEnvKeyPrefix(namespace, name string, oldSpec, newSpec *appsv1alpha1.NextAppSpec) error {
	if newSpec == nil {
		return nil
	}
	v := newSpec.Env[EnvRedisKeyPrefix]
	if oldSpec != nil && oldSpec.Env[EnvRedisKeyPrefix] == v {
		return nil
	}
	if why := EnvKeyPrefixViolation(namespace, name, v); why != "" {
		return fmt.Errorf("spec.env[%s] %s", EnvRedisKeyPrefix, why)
	}
	return nil
}
