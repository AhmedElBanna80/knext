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
	"fmt"
	"sort"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Who owns a prefix (ADR-0071 D6a rule 2). Ownership is decided by rule over the
// NextApps on one canonical endpoint, never by the order the operator happens to
// provision them in:
//
//	(a) an app whose prefix is its own derived prefix,
//	(b) then the oldest metadata.creationTimestamp,
//	(c) then the lexically smallest metadata.uid.
//
// A migration that provisions every app on an endpoint at once therefore cannot be
// raced, and a younger CR cannot take a prefix from an older one by arriving first.

// prefixClaim is one app's claim on a key prefix on one endpoint.
type prefixClaim struct {
	ref      string // "<namespace>/<name>"
	prefix   string
	username string // the ACL user this operator derives for the app
	derived  bool   // the prefix is the app's own derived prefix
	created  int64  // creationTimestamp in whole seconds: the API's resolution
	uid      string // metadata.uid
}

// newPrefixClaim is the claim an app makes. identity is the cluster identity the
// username is derived from.
func newPrefixClaim(app *appsv1alpha1.NextApp, prefix, identity string) prefixClaim {
	return prefixClaim{
		ref:      app.Namespace + "/" + app.Name,
		prefix:   prefix,
		username: redisACLUsername(identity, app),
		derived:  prefix == defaultRedisKeyPrefix(app),
		created:  app.CreationTimestamp.Unix(),
		uid:      string(app.UID),
	}
}

// ownsBefore reports whether a outranks b. It is a strict total order: the final
// comparison is the ref, so two claims never tie.
func ownsBefore(a, b prefixClaim) bool {
	if a.derived != b.derived {
		return a.derived
	}
	if a.created != b.created {
		return a.created < b.created
	}
	if a.uid != b.uid {
		return a.uid < b.uid
	}
	return a.ref < b.ref
}

// prefixBlocker returns the claim that keeps self from its prefix, or nil when self
// owns it. Claims are taken in rank order and each wins unless a claim that already
// won overlaps it, so the answer for one app does not depend on which app asks.
func prefixBlocker(claims []prefixClaim, self string) *prefixClaim {
	ranked := append([]prefixClaim(nil), claims...)
	sort.Slice(ranked, func(i, j int) bool { return ownsBefore(ranked[i], ranked[j]) })
	var winners []prefixClaim
	for _, c := range ranked {
		var blocker *prefixClaim
		for i := range winners {
			if prefixesOverlap(c.prefix, winners[i].prefix) {
				blocker = &winners[i]
				break
			}
		}
		if c.ref == self {
			return blocker
		}
		if blocker == nil {
			winners = append(winners, c)
		}
	}
	return nil
}

// outranksBecause says how c outranks loser, for the condition message.
func (c prefixClaim) outranksBecause(loser prefixClaim) string {
	switch {
	case c.derived && !loser.derived:
		return "it is the app the prefix is derived for"
	case c.created != loser.created:
		return "it is older"
	default:
		return "it wins the tiebreak on uid"
	}
}

// cacheLocalRefusal is every refusal the operator can decide from the app's own
// spec, without touching Redis. reason is "" when there is none.
func cacheLocalRefusal(app *appsv1alpha1.NextApp) (reason, message string) {
	if redisURLHasUserinfo(app.Spec.Cache.URL) {
		return ReasonCacheSharedCredentialInSpec,
			"spec.cache.url carries credentials; an isolated app gets its credential from the operator-owned Secret"
	}
	if app.Spec.Secrets != nil {
		if e, ok := app.Spec.Secrets.EnvMap["REDIS_URL"]; ok && e.SecretName != redisCredentialsSecretName(app) {
			return ReasonCacheSharedCredentialInSpec,
				"spec.secrets.envMap sets REDIS_URL; an isolated app gets it from the operator-owned Secret"
		}
	}
	prefix := operatorRedisKeyPrefix(app)
	if prefix == "" {
		return ReasonCachePrefixUnknown,
			"the app's Redis key prefix is not known to the operator (set spec.cache.keyPrefix)"
	}
	if why := reservedCachePrefix(app, prefix); why != "" {
		return ReasonCachePrefixReserved, why
	}
	return "", ""
}

// endpointApps lists the NextApps that use the given canonical Redis endpoint, with
// self (the in-memory object, which is the one being reconciled) in place of its
// stored copy. Every namespace: a prefix is global to the endpoint.
func (r *NextAppReconciler) endpointApps(ctx context.Context, self *appsv1alpha1.NextApp, canonical string) ([]*appsv1alpha1.NextApp, error) {
	var list appsv1alpha1.NextAppList
	if err := r.List(ctx, &list); err != nil {
		return nil, fmt.Errorf("list the NextApps on the endpoint: %w", err)
	}
	out := make([]*appsv1alpha1.NextApp, 0, len(list.Items)+1)
	for i := range list.Items {
		a := &list.Items[i]
		if a.Namespace == self.Namespace && a.Name == self.Name {
			continue
		}
		if !cacheIsRedis(a) {
			continue
		}
		if c, err := canonicalRedisEndpoint(a.Spec.Cache.URL, a.Namespace); err != nil || c != canonical {
			continue
		}
		out = append(out, a)
	}
	return append(out, self), nil
}

// rankedClaims are the claims of EVERY app on the endpoint whose prefix the
// operator knows (ADR-0071 D6a rule 2). Whether an app can be issued a user has
// nothing to do with whether it holds its prefix: an app with isolation: none, or
// a credential in its spec, keeps writing under its prefix on the shared
// credential. It holds the prefix without being issued a user, and any younger app
// that overlaps it fails closed. Leaving such an app out would hand its prefix to
// whoever copies it, and that app's finalizer would then sweep the original's keys.
//
// Left out: an app with no prefix the operator knows (nothing to compare), and an
// app whose prefix is reserved (the platform keyspace, or another app's derived
// shape): it is refused, and holds nothing.
func rankedClaims(apps []*appsv1alpha1.NextApp, identity string) []prefixClaim {
	var claims []prefixClaim
	for _, a := range apps {
		prefix := operatorRedisKeyPrefix(a)
		if prefix == "" || reservedCachePrefix(a, prefix) != "" {
			continue
		}
		claims = append(claims, newPrefixClaim(a, prefix, identity))
	}
	return claims
}

// holdsSharedCredential reports whether a same-endpoint app still has a working
// shared credential: it opted out of isolation, or it carries a credential in its
// own spec. Either way the endpoint cannot be called isolated.
func holdsSharedCredential(app *appsv1alpha1.NextApp) bool {
	if app.Spec.Cache.Isolation == cacheIsolationNone || redisURLHasUserinfo(app.Spec.Cache.URL) {
		return true
	}
	if app.Spec.Secrets != nil {
		if e, ok := app.Spec.Secrets.EnvMap["REDIS_URL"]; ok && e.SecretName != redisCredentialsSecretName(app) {
			return true
		}
	}
	return false
}

// conflictMessage is the PrefixConflict message for an app that lost the tiebreak.
func conflictMessage(prefix string, blocker, self prefixClaim) string {
	return fmt.Sprintf("key prefix %q overlaps %q, which %s owns (%s); "+
		"an app's key prefix must not equal, nest inside, or contain another app's",
		prefix, blocker.prefix, blocker.ref, blocker.outranksBecause(self))
}
