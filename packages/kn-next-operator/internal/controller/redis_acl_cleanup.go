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
	"errors"
	"fmt"
	"net"
	"net/url"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The finalizer's Redis half (ADR-0071 D7).

// errNoCredentialsSecret: the app never had an operator-owned credentials Secret,
// so the isolated cleanup does not apply and the plain path does.
var errNoCredentialsSecret = errors.New("no operator-owned credentials Secret")

// transientCleanupError marks a failure of the CLUSTER'S OWN API (a timeout, a
// 503, a refused connection) while deciding what to clean up. It is the one cleanup
// failure that is returned out of the finalizer so it runs again, instead of being
// logged and dropped like an unreachable external store: removing the finalizer
// needs the same API, so waiting on it cannot wedge the CR any longer than the API
// is down, and dropping it would leak the app's ACL user for good.
type transientCleanupError struct{ err error }

func (e *transientCleanupError) Error() string {
	return "transient cluster API error: " + e.err.Error()
}
func (e *transientCleanupError) Unwrap() error { return e.err }

// isTransientAPIError reports a cluster API failure that a retry can be expected to
// clear. A permanent one (Forbidden, a missing kind) is not: retrying it would hold
// the CR in Terminating for nothing.
func isTransientAPIError(err error) bool {
	if err == nil {
		return false
	}
	var netErr net.Error
	return apierrors.IsTimeout(err) || apierrors.IsServerTimeout(err) || apierrors.IsTooManyRequests(err) ||
		apierrors.IsServiceUnavailable(err) || apierrors.IsInternalError(err) || errors.As(err, &netErr)
}

// apiErr classifies an error from a cluster read made while cleaning up.
func apiErr(err error) error {
	if isTransientAPIError(err) {
		return &transientCleanupError{err: err}
	}
	return err
}

// cleanupIsolatedCache is the finalizer's half for an app that has an
// operator-owned credentials Secret. It is chosen by the presence of that Secret,
// never by status.cache (which is cleared on every pass that is not ready): an app
// deleted during a refusal, or after a switch to isolation: none, still has its
// user to remove.
//
// In order: decide whether the app owns its prefix, check the server for any other
// user that covers the same keys, re-assert the app's user from the Secret (a Redis
// restart may have lost it), sweep the app's keys as that user, then ACL DELUSER.
// The re-assert and the sweep run only when the app owns its prefix and the
// server shows no other user over it; a loser must not sweep the owner's keys, nor
// be given a user to do it with, and neither may an app whose prefix an orphan, a
// leftover of an opted-out app or another cluster's user also covers. The user is
// removed whatever else fails. When the endpoint is no longer registered the sweep
// still runs with the app's own credential (there is no server to ask), but the
// user cannot be removed, and the error returned names it.
func (r *NextAppReconciler) cleanupIsolatedCache(ctx context.Context, app *appsv1alpha1.NextApp, keyPrefix string) error {
	logger := logf.FromContext(ctx)
	if r.APIReader == nil && r.Client == nil {
		// No cluster client wired: unit tests of unrelated paths, the same
		// convention as a nil Cleaner. There is no Secret to find.
		return errNoCredentialsSecret
	}
	var sec corev1.Secret
	if err := r.reader().Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: redisCredentialsSecretName(app)}, &sec); err != nil {
		if apierrors.IsNotFound(err) {
			return errNoCredentialsSecret
		}
		return apiErr(err)
	}
	if !controlledByZone(&sec, app) {
		return errNoCredentialsSecret
	}
	snap, err := r.loadPlatform(ctx)
	if err != nil {
		return apiErr(err)
	}
	canonical, cerr := canonicalRedisEndpoint(app.Spec.Cache.URL, app.Namespace)
	if cerr != nil {
		return cerr
	}
	identity, err := r.clusterIdentity(ctx, snap)
	if err != nil {
		return apiErr(err)
	}
	username := redisACLUsername(identity, app)

	// From here the user must be removed whatever else goes wrong: what cannot be
	// decided only costs the sweep.
	var notDone []error
	owns, err := r.ownsPrefixForCleanup(ctx, app, canonical, keyPrefix, identity)
	if err != nil {
		owns = false
		notDone = append(notDone, fmt.Errorf("the keyspace %q was not swept, ownership could not be decided: %w", keyPrefix, apiErr(err)))
	}

	ep, registered := registeredEndpoint(snap, canonical)
	var prov RedisProvisioner
	var dialErr error
	if registered {
		var provURL string
		if provURL, dialErr = r.provisionerURL(ctx, ep); dialErr == nil {
			if prov, dialErr = r.redisDialer()(ctx, provURL); dialErr == nil {
				defer func() { _ = prov.Close() }()
			}
		}
	}

	if owns && prov != nil {
		// Ask the server before the user is re-asserted: any other user over these
		// keys means the sweep would reach keys that are not this app's.
		conflict, cerr := prefixConflict(ctx, prov, username, keyPrefix)
		switch {
		case cerr != nil:
			owns = false
			notDone = append(notDone, fmt.Errorf("the keyspace %q was not swept, the endpoint could not be checked for other users: %s", keyPrefix, redactErr(cerr)))
		case conflict != "":
			owns = false
			logger.Info("Not sweeping: another ACL user covers the same keys", "keyPrefix", keyPrefix)
		}
	}

	appURL := string(sec.Data[redisCredentialsSecretKey])
	if owns && appURL != "" && r.Cleaner != nil {
		if prov != nil {
			if err := reassertForCleanup(ctx, prov, app, keyPrefix, username, appURL); err != nil {
				logger.Error(err, "re-asserting the app's ACL user before the sweep failed", "keyPrefix", keyPrefix)
			}
		}
		if err := r.Cleaner.CleanupCache(ctx, CacheTarget{Provider: redisURLScheme, URL: appURL, KeyPrefix: keyPrefix}); err != nil {
			logger.Error(err, "sweeping the isolated keyspace as the app user failed", "keyPrefix", keyPrefix)
		}
	}

	var userErr error
	switch {
	case prov != nil:
		userErr = prov.DelUser(ctx, username)
	case !registered:
		userErr = fmt.Errorf("the Redis endpoint is no longer registered, so the ACL user %q was left on it", username)
	default:
		userErr = fmt.Errorf("the ACL user %q was left on the endpoint: %w", username, dialErr)
	}
	return errors.Join(append([]error{userErr}, notDone...)...)
}

// cleanupPlainCache sweeps the app's keyspace with the credential in
// spec.cache.url: the path for an app that never had an operator-owned user. A
// prefix in the platform's or another app's range is never swept, whatever the
// credential could reach (ADR-0071 D6a): deleting a squatting CR must not delete
// the owner's cache. On a registered endpoint the same holds for a prefix that an
// older app on the endpoint holds, whether or not that app can be issued a user: an
// app that was refused for copying it has no Secret, so it lands here, and on an
// open Redis its spec.cache.url would reap the original's keys.
func (r *NextAppReconciler) cleanupPlainCache(ctx context.Context, app *appsv1alpha1.NextApp, keyPrefix string) error {
	logger := logf.FromContext(ctx)
	if why := reservedCachePrefix(app, keyPrefix); why != "" {
		logger.Info("Not sweeping a reserved key prefix", "keyPrefix", keyPrefix, "reason", why)
		return nil
	}
	owns, err := r.mayPlainSweep(ctx, app, keyPrefix)
	if err != nil {
		return fmt.Errorf("the keyspace %q was not swept, ownership could not be decided: %w", keyPrefix, apiErr(err))
	}
	if !owns {
		logger.Info("Not sweeping: an older app on the endpoint holds an overlapping prefix", "keyPrefix", keyPrefix)
		return nil
	}
	return r.Cleaner.CleanupCache(ctx, CacheTarget{
		Provider:  app.Spec.Cache.Provider,
		URL:       app.Spec.Cache.URL,
		KeyPrefix: keyPrefix,
	})
}

// mayPlainSweep applies the ownership rule to an app on the plain path. Off a
// registered endpoint there is no ownership regime (apps there share the keyspace
// on purpose and the CLI's doctor warns about it), so the answer is yes.
func (r *NextAppReconciler) mayPlainSweep(ctx context.Context, app *appsv1alpha1.NextApp, keyPrefix string) (bool, error) {
	snap, err := r.loadPlatform(ctx)
	if err != nil {
		return false, err
	}
	canonical, cerr := canonicalRedisEndpoint(app.Spec.Cache.URL, app.Namespace)
	if cerr != nil {
		return true, nil
	}
	if _, registered := registeredEndpoint(snap, canonical); !registered {
		return true, nil
	}
	return r.ownsPrefixForCleanup(ctx, app, canonical, keyPrefix, "")
}

// reassertForCleanup runs ACL SETUSER from the Secret's credential, the same
// arguments a reconcile would use, so the sweep does not run as a user a Redis
// restart removed.
func reassertForCleanup(ctx context.Context, prov RedisProvisioner, app *appsv1alpha1.NextApp, prefix, username, appURL string) error {
	u, err := url.Parse(appURL)
	if err != nil || u.User == nil || u.User.Username() != username {
		return errors.New("the credentials Secret does not hold this app's user")
	}
	password, set := u.User.Password()
	if !set || password == "" {
		return errors.New("the credentials Secret holds no password")
	}
	cdn := ""
	if cdnRendersEnv(app) {
		cdn = cdnTagPrefix(app)
	}
	return prov.SetUser(ctx, username, redisACLRules(prefix, password, "", cdn))
}

// ownsPrefixForCleanup says whether deleting the app may sweep its prefix: the
// prefix is not reserved, and no app that holds an overlapping prefix on the same
// endpoint outranks it. Every app with a known prefix is ranked, whether or not it
// can be issued a user, and the deleting app is counted as a claimant whatever its
// own isolation setting, so an app that opted out cannot reap an owner's cache.
func (r *NextAppReconciler) ownsPrefixForCleanup(ctx context.Context, app *appsv1alpha1.NextApp, canonical, prefix, identity string) (bool, error) {
	if reservedCachePrefix(app, prefix) != "" {
		return false, nil
	}
	apps, err := r.endpointApps(ctx, app, canonical)
	if err != nil {
		return false, err
	}
	self := newPrefixClaim(app, prefix, identity)
	claims := []prefixClaim{self}
	for _, c := range rankedClaims(apps, identity) {
		if c.ref != self.ref {
			claims = append(claims, c)
		}
	}
	return prefixBlocker(claims, self.ref) == nil, nil
}
