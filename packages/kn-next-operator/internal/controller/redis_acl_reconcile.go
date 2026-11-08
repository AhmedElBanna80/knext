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
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// Reasons of the CacheCredentialsReady condition (ADR-0071 D2).
const (
	ConditionCacheCredentialsReady = "CacheCredentialsReady"

	ReasonCacheProvisioned            = "Provisioned"
	ReasonCacheSharedCredentialLive   = "SharedCredentialLive"
	ReasonCacheEndpointUnregistered   = "EndpointUnregistered"
	ReasonCacheAclUnsupported         = "AclUnsupported"
	ReasonCacheProvisionerRefused     = "ProvisionerRefused"
	ReasonCachePrefixConflict         = "PrefixConflict"
	ReasonCachePrefixReserved         = "PrefixReserved"
	ReasonCacheSharedCredentialInSpec = "SharedCredentialInSpec"
	ReasonCachePrefixUnknown          = "PrefixUnknown"

	// cacheSharedLiveMessage is the exact wording the ADR requires while the
	// shared path is not observed refused. No wording that says "isolated" may be
	// used before the endpoint's own state shows it.
	cacheSharedLiveMessage = "isolation not in force: shared credential live"

	// cacheInForceMessage is the only isolation claim the operator makes, and only
	// after sharedPathLive found nothing on the endpoint (server state, not probes).
	cacheInForceMessage = "isolation in force: the app runs under its own ACL user and no other enabled user " +
		"on the endpoint, apart from the provisioner, reaches app keys"

	cacheResyncInterval = 5 * time.Minute
	// cacheRetryInterval is how soon a pass that could not finish, or that lost a
	// conflict that may resolve, is tried again. The verdict owns the requeue.
	cacheRetryInterval = 30 * time.Second
)

// RedisProvisioner is the operator's view of one registered Redis endpoint. It
// is an interface so the reconcile logic is tested without a Redis.
type RedisProvisioner interface {
	// Version returns the server version (redis_version).
	Version(ctx context.Context) (string, error)
	SetUser(ctx context.Context, username string, rules []string) error
	DelUser(ctx context.Context, username string) error
	// Users lists every user on the endpoint (ACL USERS).
	Users(ctx context.Context) ([]string, error)
	// GetUser reports one user's flags and key patterns (ACL GETUSER).
	GetUser(ctx context.Context, username string) (ACLUserInfo, error)
	// Username is the user the provisioner itself authenticated as. A client that
	// sends no username authenticates as "default".
	Username() string
	// SharedCredentialLive is the ADR-0071 condition 4 probe: does the endpoint
	// accept a connection that presents no credential, or the default user with a
	// password nobody issued. It is NECESSARY for an isolation claim, never
	// sufficient: under requirepass both are refused while the real shared
	// password still holds every key. detail names which probe succeeded.
	SharedCredentialLive(ctx context.Context) (live bool, detail string, err error)
	Close() error
}

// ACLUserInfo is what the endpoint reports about one user (ACL GETUSER): whether
// it can log in and which key patterns it may touch.
type ACLUserInfo struct {
	Name string
	// Enabled is the "on" flag. A user that is "off" cannot authenticate.
	Enabled bool
	// KeyPatterns are every key pattern the user holds, root and selectors, as
	// Redis prints them ("~*", "~app:*", "%R~x*").
	KeyPatterns []string
	// CommandRules are the command rules the user holds, root first and then each
	// selector's, as Redis prints them ("+@all -debug", "-@all +get").
	CommandRules []string
}

// RedisProvisionerDialer connects to an endpoint with the provisioner URL.
type RedisProvisionerDialer func(ctx context.Context, provisionerURL string) (RedisProvisioner, error)

// cacheCredentialsState is the outcome of the cache-credentials step for the
// verdict and for the env render.
type cacheCredentialsState struct {
	// active: the app has a Redis cache whose isolation was requested or is in
	// force. False means the shared path as always: no condition is reported.
	active bool
	// failClosed: the render must point REDIS_URL at the operator-owned Secret
	// even though it may not exist, never at the shared URL.
	failClosed bool
	ready      bool
	reason     string
	message    string
	username   string
	secretName string
}

// operatorNamespace is where provisioner Secrets live.
func operatorNamespace() string {
	if ns := os.Getenv("POD_NAMESPACE"); ns != "" {
		return ns
	}
	if b, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/namespace"); err == nil && len(b) > 0 {
		return strings.TrimSpace(string(b))
	}
	return "kn-next-operator-system"
}

func (r *NextAppReconciler) redisDialer() RedisProvisionerDialer {
	if r.RedisDialer != nil {
		return r.RedisDialer
	}
	return dialGoRedisProvisioner
}

// registeredEndpoint finds the platform registration for a canonical endpoint.
func registeredEndpoint(snap platformSnapshot, canonical string) (platformv1alpha1.RedisEndpoint, bool) {
	spec := snap.active()
	if spec == nil || spec.Cache == nil {
		return platformv1alpha1.RedisEndpoint{}, false
	}
	for _, e := range spec.Cache.RedisEndpoints {
		if e.Endpoint == canonical {
			return e, true
		}
	}
	return platformv1alpha1.RedisEndpoint{}, false
}

// reservedCachePrefix reports ADR-0071 D6a rules 0 and 1 for an app's prefix. The
// rule lives in internal/validation, next to the admission check that applies it
// at write time, so the two cannot drift.
func reservedCachePrefix(app *appsv1alpha1.NextApp, prefix string) string {
	return validation.CacheKeyPrefixViolation(app.Namespace, app.Name, prefix)
}

// prefixesOverlap reports whether two key prefixes can address the same keys:
// equal, or one nested inside the other at a ':' boundary.
func prefixesOverlap(a, b string) bool {
	return a == b || strings.HasPrefix(a, b+":") || strings.HasPrefix(b, a+":")
}

// patternPrefix extracts "<prefix>" from an ACL key pattern "~<prefix>:*" (also
// "%RW~"). ok is false for any pattern that is not of that shape, which the
// caller must treat as overlapping everything (fail closed).
func patternPrefix(p string) (prefix string, ok bool) {
	if i := strings.Index(p, "~"); i >= 0 {
		p = p[i+1:]
	}
	if !strings.HasSuffix(p, ":*") {
		return "", false
	}
	p = strings.TrimSuffix(p, ":*")
	var b strings.Builder
	for i := 0; i < len(p); i++ {
		if p[i] == '\\' && i+1 < len(p) {
			i++
		}
		b.WriteByte(p[i])
	}
	return b.String(), true
}

// patternMayCoverPrefix reports whether an ACL key pattern can address a key under
// "<prefix>:". It errs toward yes: a pattern is judged by its literal head (the
// text before the first glob character), and anything whose head and the app's
// "<prefix>:" are not provably different counts as covering. "~*" covers every
// prefix; "~billing:*" covers none of "shop-web".
func patternMayCoverPrefix(pattern, prefix string) bool {
	if i := strings.Index(pattern, "~"); i >= 0 {
		pattern = pattern[i+1:]
	}
	var head strings.Builder
	glob := false
scan:
	for i := 0; i < len(pattern); i++ {
		switch pattern[i] {
		case '*', '?', '[':
			glob = true
			break scan
		case '\\':
			if i+1 < len(pattern) {
				i++
			}
		}
		head.WriteByte(pattern[i])
	}
	h, target := head.String(), prefix+":"
	if glob {
		return strings.HasPrefix(target, h) || strings.HasPrefix(h, target)
	}
	return strings.HasPrefix(h, target)
}

// newRedisPassword is 32 random bytes, URL-safe.
func newRedisPassword() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (r *NextAppReconciler) clusterIdentity(ctx context.Context, snap platformSnapshot) (string, error) {
	if snap.obj != nil && snap.obj.Spec.Cache != nil && snap.obj.Spec.Cache.ClusterID != "" {
		return snap.obj.Spec.Cache.ClusterID, nil
	}
	var ns corev1.Namespace
	if err := r.reader().Get(ctx, types.NamespacedName{Name: "kube-system"}, &ns); err != nil {
		return "", fmt.Errorf("read the kube-system Namespace for the cluster identity: %w", err)
	}
	return string(ns.UID), nil
}

// reconcileCacheCredentials is the cache-credentials step (ADR-0071 D2/D3/D6).
// A condition the app can be told about is the returned state's reason, never an
// error. A returned error is a transient failure to complete the step; Reconcile
// turns it into a ProvisionerRefused-class state (transientCacheCredentials), so
// the verdict, not the pass, reports and requeues it.
func (r *NextAppReconciler) reconcileCacheCredentials(ctx context.Context, app *appsv1alpha1.NextApp, snap platformSnapshot) (cacheCredentialsState, error) { //nolint:gocyclo // one ordered pass over the ADR's refusal table; splitting it would hide the order
	if !cacheIsRedis(app) {
		return cacheCredentialsState{}, nil
	}
	canonical, cerr := canonicalRedisEndpoint(app.Spec.Cache.URL, app.Namespace)
	ep, registered := registeredEndpoint(snap, canonical)
	if cerr != nil {
		registered = false
	}
	mode := resolveCacheIsolation(app.Spec.Cache.Isolation, registered)
	switch mode {
	case isolationShared:
		return cacheCredentialsState{}, nil
	case isolationRequiredUnavailable:
		return failClosedCache(app, ReasonCacheEndpointUnregistered,
			"spec.cache.isolation is acl, but the Redis endpoint of spec.cache.url is not registered on the KnextPlatform"), nil
	}

	st := cacheCredentialsState{
		active:     true,
		failClosed: true,
		reason:     ReasonCacheProvisionerRefused,
		secretName: redisCredentialsSecretName(app),
	}
	fail := func(reason, msg string) (cacheCredentialsState, error) {
		st.reason, st.message = reason, msg
		return st, nil
	}

	if reason, msg := cacheLocalRefusal(app); reason != "" {
		if reason == ReasonCachePrefixReserved {
			// The prefix reaches another app's keys. A user issued before the rule
			// applied (a CR admitted earlier) must not keep that reach.
			msg += r.revokeAfterRefusal(ctx, app, snap, ep)
		}
		return fail(reason, msg)
	}
	prefix := operatorRedisKeyPrefix(app)

	identity, err := r.clusterIdentity(ctx, snap)
	if err != nil {
		return st, err
	}
	st.username = redisACLUsername(identity, app)

	provURL, err := r.provisionerURL(ctx, ep)
	if err != nil {
		return fail(ReasonCacheProvisionerRefused, "the provisioner credential cannot be used: "+redactErr(err))
	}
	prov, err := r.redisDialer()(ctx, provURL)
	if err != nil {
		return fail(ReasonCacheProvisionerRefused, "cannot connect to the registered endpoint: "+redactErr(err))
	}
	defer func() { _ = prov.Close() }()

	ver, err := prov.Version(ctx)
	if err != nil {
		return fail(ReasonCacheProvisionerRefused, "cannot read the server version: "+redactErr(err))
	}
	if major := redisMajor(ver); major < 7 {
		return fail(ReasonCacheAclUnsupported, fmt.Sprintf("Redis/Valkey %s is older than 7.0", ver))
	}

	// D6a rule 2: who owns the prefix is decided over every app on this endpoint,
	// never by who got here first.
	apps, err := r.endpointApps(ctx, app, canonical)
	if err != nil {
		return st, err
	}
	self := newPrefixClaim(app, prefix, identity)
	claims := rankedClaims(apps, identity)
	if blocker := prefixBlocker(claims, self.ref); blocker != nil {
		// The loser holds no user: one issued before the owner came into view is
		// revoked, or it would keep reaching the owner's keys.
		return fail(ReasonCachePrefixConflict, conflictMessage(prefix, *blocker, self)+revokeUser(ctx, prov, st.username))
	}
	// D6a rule 3: what is on the endpoint, not only the CRs. Evicts the users of
	// visible losers; anything else that overlaps wins against this app.
	conflict, err := claimPrefix(ctx, prov, self, claims)
	if err != nil {
		return fail(ReasonCacheProvisionerRefused, "cannot read the users on the endpoint: "+redactErr(err))
	}
	if conflict != "" {
		return fail(ReasonCachePrefixConflict, conflict)
	}

	// The Secret is written BEFORE the user: the re-assert is a pure function of
	// the Secret, so a crash between the two leaves a Secret the next pass uses.
	password, err := r.ensureCredentialsSecret(ctx, app, canonical, st.username)
	if errors.Is(err, errCredentialsSecretForeign) {
		return fail(ReasonCacheProvisionerRefused, "the Secret "+st.secretName+" exists and is not controlled by this app")
	}
	if err != nil {
		return st, err
	}
	cdn := ""
	if cdnRendersEnv(app) {
		cdn = cdnTagPrefix(app)
	}
	if err := prov.SetUser(ctx, st.username, redisACLRules(prefix, password, "", cdn)); err != nil {
		return fail(ReasonCacheProvisionerRefused, "ACL SETUSER was refused: "+redactErr(err))
	}

	// Look again now that the write has landed. Another claimant that checked at the
	// same moment, from a view that differs from this one, may have written too; an
	// overlapping user that is not a visible loser's fails this app closed rather
	// than leaving two users over the same keys.
	conflict, err = claimPrefix(ctx, prov, self, claims)
	if err != nil {
		return fail(ReasonCacheProvisionerRefused, "cannot read the users on the endpoint: "+redactErr(err))
	}
	if conflict != "" {
		return fail(ReasonCachePrefixConflict, conflict+revokeUser(ctx, prov, st.username))
	}

	st.failClosed = false
	st.ready = true
	if live, detail := sharedPathLive(ctx, prov, apps, app); live {
		st.reason, st.message = ReasonCacheSharedCredentialLive, cacheSharedLiveMessage+" ("+detail+")"
	} else {
		st.reason, st.message = ReasonCacheProvisioned, cacheInForceMessage
	}
	return st, nil
}

// transientCacheCredentials is the state of a pass whose cache-credentials step
// could not finish (an API or Redis blip). It is a ProvisionerRefused-class state
// and fails closed: the verdict reports it and owns the retry, so a Provisioned
// condition from an earlier pass cannot outlive the pass that could not confirm it.
func transientCacheCredentials(app *appsv1alpha1.NextApp, err error) cacheCredentialsState {
	return cacheCredentialsState{
		active: true, failClosed: true, reason: ReasonCacheProvisionerRefused,
		message:    "the cache credentials could not be reconciled and will be retried: " + redactErr(err),
		secretName: redisCredentialsSecretName(app),
	}
}

func failClosedCache(app *appsv1alpha1.NextApp, reason, msg string) cacheCredentialsState {
	return cacheCredentialsState{
		active: true, failClosed: true, reason: reason, message: msg,
		secretName: redisCredentialsSecretName(app),
	}
}

// cacheRetries reports whether a not-ready state can clear without a spec change,
// so the verdict should look again soon rather than wait for the next event.
func cacheRetries(st cacheCredentialsState) bool {
	switch st.reason {
	case ReasonCacheProvisionerRefused, ReasonCacheAclUnsupported, ReasonCachePrefixConflict:
		return true
	}
	return false
}

func redisMajor(version string) int {
	head, _, _ := strings.Cut(version, ".")
	n, err := strconv.Atoi(strings.TrimSpace(head))
	if err != nil {
		return 0
	}
	return n
}

var redisURLInError = regexp.MustCompile(`redis(s)?://[^\s]*@`)

// redactErr keeps a Redis error from carrying a URL with a password.
func redactErr(err error) string {
	return redisURLInError.ReplaceAllString(err.Error(), "redis$1://***@")
}

// revokeUser removes the app's own ACL user and returns text for the condition
// message when that failed. ACL DELUSER of a user that is not there is not an error.
func revokeUser(ctx context.Context, prov RedisProvisioner, username string) string {
	if err := prov.DelUser(ctx, username); err != nil {
		return " (the app's ACL user could not be removed: " + redactErr(err) + ")"
	}
	return ""
}

// revokeAfterRefusal dials the registered endpoint and removes the app's own ACL
// user. Best-effort: the refusal stands whatever happens here.
func (r *NextAppReconciler) revokeAfterRefusal(ctx context.Context, app *appsv1alpha1.NextApp, snap platformSnapshot, ep platformv1alpha1.RedisEndpoint) string {
	identity, err := r.clusterIdentity(ctx, snap)
	if err != nil {
		return " (the app's earlier ACL user could not be checked: " + redactErr(err) + ")"
	}
	provURL, err := r.provisionerURL(ctx, ep)
	if err != nil {
		return " (the app's earlier ACL user could not be checked: " + redactErr(err) + ")"
	}
	prov, err := r.redisDialer()(ctx, provURL)
	if err != nil {
		return " (the app's earlier ACL user could not be checked: " + redactErr(err) + ")"
	}
	defer func() { _ = prov.Close() }()
	return revokeUser(ctx, prov, redisACLUsername(identity, app))
}

// claimPrefix settles the endpoint side of D6a for an app that owns its prefix by
// rule. Every other claim that overlaps it is a loser by construction, so the
// users of those apps are removed; any other overlapping knext-app-* user (an
// orphan, another cluster's) is a conflict and is never touched.
func claimPrefix(ctx context.Context, prov RedisProvisioner, self prefixClaim, claims []prefixClaim) (string, error) {
	users, err := prov.Users(ctx)
	if err != nil {
		return "", err
	}
	present := make(map[string]bool, len(users))
	for _, u := range users {
		present[u] = true
	}
	for _, c := range claims {
		if c.ref == self.ref || !present[c.username] || !prefixesOverlap(self.prefix, c.prefix) {
			continue
		}
		// The claim says the loser WANTS an overlapping prefix; what its user can
		// touch is what the server holds, and the cached spec can be stale (the
		// user may have been re-asserted for another prefix since). Evict only a
		// user whose actual patterns overlap, and never one that cannot be read.
		info, err := prov.GetUser(ctx, c.username)
		if err != nil {
			return "", err
		}
		if !userOverlapsPrefix(info, self.prefix) {
			continue
		}
		if err := prov.DelUser(ctx, c.username); err != nil {
			return "", err
		}
	}
	return prefixConflict(ctx, prov, self.username, self.prefix)
}

// userOverlapsPrefix reports whether any key pattern the user holds can address
// keys under the prefix: equal, nested either way, or a pattern the operator
// cannot reason about (which counts as overlapping everything).
func userOverlapsPrefix(info ACLUserInfo, prefix string) bool {
	for _, p := range info.KeyPatterns {
		other, ok := patternPrefix(p)
		if !ok || prefixesOverlap(prefix, other) {
			return true
		}
	}
	return false
}

func prefixConflict(ctx context.Context, prov RedisProvisioner, ownUser, prefix string) (string, error) {
	users, err := prov.Users(ctx)
	if err != nil {
		return "", err
	}
	for _, u := range users {
		if u == ownUser || !strings.HasPrefix(u, redisACLUsernamePrefix) {
			continue
		}
		info, err := prov.GetUser(ctx, u)
		if err != nil {
			return "", err
		}
		if userOverlapsPrefix(info, prefix) {
			return fmt.Sprintf("another ACL user on the endpoint already covers keys under %q; "+
				"an app's key prefix must not equal, nest inside, or contain another app's", prefix), nil
		}
	}
	return "", nil
}

// sharedPathLive decides, from the endpoint's own state, whether a shared
// credential can still reach app keys. The operator makes an isolation claim only
// when it reports false. Order: what the apps on the endpoint hold, then what the
// server says about every user, then the ADR's two probes.
//
// The probes alone prove nothing: under requirepass a no-credential connect and
// AUTH default with a random password are both refused while the real shared
// password still holds every key. A named shared user is never probed at all.
func sharedPathLive(ctx context.Context, prov RedisProvisioner, apps []*appsv1alpha1.NextApp, self *appsv1alpha1.NextApp) (live bool, detail string) {
	var prefixes []string
	for _, a := range apps {
		if p := operatorRedisKeyPrefix(a); p != "" {
			prefixes = append(prefixes, p)
		}
		if a != self && holdsSharedCredential(a) {
			return true, fmt.Sprintf("app %s/%s still holds a shared credential (isolation: none, or a credential in its spec)", a.Namespace, a.Name)
		}
	}

	provisioner := prov.Username()
	if provisioner == "" || provisioner == "default" {
		return true, "the provisioner authenticates as the default user, so the shared credential is the operator's own"
	}
	users, err := prov.Users(ctx)
	if err != nil {
		return true, "the check failed: " + redactErr(err)
	}
	for _, u := range users {
		if u == provisioner || strings.HasPrefix(u, redisACLUsernamePrefix) {
			continue
		}
		info, err := prov.GetUser(ctx, u)
		if err != nil {
			return true, "the check failed: " + redactErr(err)
		}
		if !info.Enabled {
			continue
		}
		for _, p := range info.KeyPatterns {
			for _, prefix := range prefixes {
				if patternMayCoverPrefix(p, prefix) {
					return true, fmt.Sprintf("user %q is enabled and its key pattern %q reaches app keys", u, p)
				}
			}
		}
		// Keys are not the whole story: a user with no key pattern can still stream
		// the dataset (PSYNC, SYNC, MONITOR) or grant itself anything (ACL SETUSER).
		for _, rules := range info.CommandRules {
			if cmd, dangerous := commandRulesAllowDangerous(rules); dangerous {
				return true, fmt.Sprintf("user %q is enabled and can run %s", u, cmd)
			}
		}
	}

	live, probe, err := prov.SharedCredentialLive(ctx)
	switch {
	case err != nil:
		return true, "the probe failed: " + redactErr(err)
	case live:
		return true, probe
	}
	return false, ""
}

func (r *NextAppReconciler) reader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

// provisionerURL reads the provisioner Secret and returns its URL pinned to the
// registered endpoint (ADR-0071 D1: endpoint-bound). A Secret whose host does not
// canonicalise to exactly the registered endpoint is refused, and one that does is
// dialled at the registered form, never at the Secret's own spelling, so the
// credential cannot be sent anywhere the platform admin did not register.
func (r *NextAppReconciler) provisionerURL(ctx context.Context, ep platformv1alpha1.RedisEndpoint) (string, error) {
	var sec corev1.Secret
	key := types.NamespacedName{Namespace: operatorNamespace(), Name: ep.ProvisionerSecretRef.Name}
	if err := r.reader().Get(ctx, key, &sec); err != nil {
		return "", fmt.Errorf("get Secret %s/%s: %w", key.Namespace, key.Name, err)
	}
	v, ok := sec.Data[ep.ProvisionerSecretRef.Key]
	if !ok || len(v) == 0 {
		return "", fmt.Errorf("secret %s/%s has no key %q", key.Namespace, key.Name, ep.ProvisionerSecretRef.Key)
	}
	raw := strings.TrimSpace(string(v))
	// The errors below never carry raw: it holds the provisioner's password.
	if canonical, err := canonicalRedisEndpoint(raw, operatorNamespace()); err != nil || canonical != ep.Endpoint {
		return "", fmt.Errorf("secret %s/%s does not point at the registered endpoint %s", key.Namespace, key.Name, ep.Endpoint)
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("secret %s/%s does not hold a URL", key.Namespace, key.Name)
	}
	u.Host = ep.Endpoint
	return u.String(), nil
}

// errCredentialsSecretForeign: the reserved Secret name is taken by an object
// this NextApp does not control (a squatter, or a leftover from an earlier app of
// the same name). It is never written.
var errCredentialsSecretForeign = errors.New("the Secret name is held by an object this NextApp does not control")

// ensureCredentialsSecret creates the operator-owned Secret on first use and
// returns the current password. An existing, well-formed Secret is reused, so a
// reconcile never changes the password (rotation is a separate step).
func (r *NextAppReconciler) ensureCredentialsSecret(ctx context.Context, app *appsv1alpha1.NextApp, canonical, username string) (string, error) {
	scheme := redisURLScheme
	if u, err := url.Parse(app.Spec.Cache.URL); err == nil && u.Scheme == redisURLSchemeTLS {
		scheme = redisURLSchemeTLS
	}
	var existing corev1.Secret
	var current *corev1.Secret
	switch err := r.reader().Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: RedisCredentialsSecretName(app.Name)}, &existing); {
	case err == nil:
		if !controlledByZone(&existing, app) {
			return "", errCredentialsSecretForeign
		}
		current = &existing
	case !apierrors.IsNotFound(err):
		return "", fmt.Errorf("read the credentials Secret: %w", err)
	}

	password := ""
	if current != nil {
		if u, perr := url.Parse(string(current.Data[redisCredentialsSecretKey])); perr == nil && u.User != nil &&
			u.User.Username() == username && u.Host == canonical {
			if pw, set := u.User.Password(); set {
				password = pw
			}
		}
	}
	if password == "" {
		pw, err := newRedisPassword()
		if err != nil {
			return "", err
		}
		password = pw
	}
	data := map[string][]byte{redisCredentialsSecretKey: []byte(appRedisURL(scheme, canonical, username, password))}
	if current != nil && string(current.Data[redisCredentialsSecretKey]) == string(data[redisCredentialsSecretKey]) {
		return password, nil // already converged: no write
	}
	if err := r.writeCredentialsSecret(ctx, app, current, data); err != nil {
		return "", fmt.Errorf("write the credentials Secret: %w", err)
	}
	return password, nil
}

// writeCredentialsSecret is the only writer of the credentials Secret: a create
// (with the NextApp as controller, set once) or an update with the read
// resourceVersion. No patch, no delete: the NextApp ownerReference collects it.
func (r *NextAppReconciler) writeCredentialsSecret(ctx context.Context, app *appsv1alpha1.NextApp, sec *corev1.Secret, data map[string][]byte) error {
	if sec == nil {
		sec = &corev1.Secret{
			Name:      RedisCredentialsSecretName(app.Name),
			Namespace: app.Namespace,
			Labels:    map[string]string{generatedByLabelKey: OperatorFieldManager},
			Type:      corev1.SecretTypeOpaque,
			Data:      data,
		}
		if err := controllerutil.SetControllerReference(app, sec, r.Scheme); err != nil {
			return err
		}
		return r.Create(ctx, sec)
	}
	sec.Data = data
	return r.Update(ctx, sec)
}

// isOperatorCacheBinding reports whether an envMap entry is the REDIS_URL binding
// injectCacheCredentialsEnv put there: the operator's own Secret and key.
func isOperatorCacheBinding(app *appsv1alpha1.NextApp, envName string, entry appsv1alpha1.EnvMapEntry) bool {
	return envName == "REDIS_URL" && entry.SecretName == redisCredentialsSecretName(app) &&
		entry.SecretKey == redisCredentialsSecretKey
}

// injectCacheCredentialsEnv points REDIS_URL at the operator-owned Secret, in
// memory only (like the database binding): the user's own spec is never written.
// When failClosed, the reference is injected even though the Secret may not
// exist, so the pod cannot start on the shared credential.
func injectCacheCredentialsEnv(app *appsv1alpha1.NextApp, st cacheCredentialsState) {
	if !st.active {
		return
	}
	if app.Spec.Secrets == nil {
		app.Spec.Secrets = &appsv1alpha1.SecretsSpec{}
	}
	m := make(map[string]appsv1alpha1.EnvMapEntry, len(app.Spec.Secrets.EnvMap)+1)
	maps.Copy(m, app.Spec.Secrets.EnvMap)
	m["REDIS_URL"] = appsv1alpha1.EnvMapEntry{SecretName: st.secretName, SecretKey: redisCredentialsSecretKey}
	app.Spec.Secrets.EnvMap = m
}

// Values of status.cache.isolation.
const (
	// cacheStatusIsolationACL: the app runs under its own ACL user AND the endpoint
	// shows no other way to reach its keys (the CacheCredentialsReady reason is
	// Provisioned). It is an isolation claim, made on the same terms as the message.
	cacheStatusIsolationACL = "acl"
	// cacheStatusIsolationPending: the app runs under its own ACL user, but
	// isolation is not in force; the condition says why.
	cacheStatusIsolationPending = "acl-pending"
)

// cacheStatusFor is status.cache for one pass. The field is named isolation, so it
// makes the same claim as the condition message and on the same terms: "acl" only
// when the reason is Provisioned.
func cacheStatusFor(st cacheCredentialsState) *appsv1alpha1.CacheStatus {
	if !st.active || !st.ready {
		return nil
	}
	isolation := cacheStatusIsolationPending
	if st.reason == ReasonCacheProvisioned {
		isolation = cacheStatusIsolationACL
	}
	return &appsv1alpha1.CacheStatus{Isolation: isolation, Username: st.username, SecretName: st.secretName}
}

// Cluster identity (ADR-0071 D2): the kube-system Namespace uid, read only when
// KnextPlatform spec.cache.clusterId is unset. Nothing else about Namespaces.
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get

// ── go-redis implementation ─────────────────────────────────────────────────

type goRedisProvisioner struct {
	rdb      *redis.Client
	username string
}

func dialGoRedisProvisioner(ctx context.Context, provisionerURL string) (RedisProvisioner, error) {
	opt, err := redis.ParseURL(provisionerURL)
	if err != nil {
		return nil, errors.New("the provisioner URL does not parse")
	}
	opt.DialTimeout, opt.ReadTimeout, opt.WriteTimeout = 5*time.Second, 5*time.Second, 5*time.Second
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, err
	}
	return &goRedisProvisioner{rdb: rdb, username: opt.Username}, nil
}

func (g *goRedisProvisioner) Close() error { return g.rdb.Close() }

// Username is the user the connection authenticated as; none sent means default.
func (g *goRedisProvisioner) Username() string {
	if g.username == "" {
		return "default"
	}
	return g.username
}

func (g *goRedisProvisioner) Version(ctx context.Context) (string, error) {
	info, err := g.rdb.Info(ctx, "server").Result()
	if err != nil {
		return "", err
	}
	for line := range strings.SplitSeq(info, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "redis_version:"); ok {
			return v, nil
		}
	}
	return "", errors.New("INFO server has no redis_version")
}

func (g *goRedisProvisioner) SetUser(ctx context.Context, username string, rules []string) error {
	args := append([]any{"ACL", "SETUSER", username}, toAny(rules)...)
	return g.rdb.Do(ctx, args...).Err()
}

func (g *goRedisProvisioner) DelUser(ctx context.Context, username string) error {
	return g.rdb.Do(ctx, "ACL", "DELUSER", username).Err()
}

func (g *goRedisProvisioner) Users(ctx context.Context) ([]string, error) {
	return g.rdb.Do(ctx, "ACL", "USERS").StringSlice()
}

func (g *goRedisProvisioner) GetUser(ctx context.Context, username string) (ACLUserInfo, error) {
	res, err := g.rdb.Do(ctx, "ACL", "GETUSER", username).Result()
	if err != nil {
		return ACLUserInfo{}, err
	}
	return parseACLGetUser(username, res)
}

// parseACLGetUser reads an ACL GETUSER reply in either protocol shape: RESP3 is a
// map, RESP2 a flat array of key, value pairs. Selectors (Redis 7) carry their own
// key patterns and command rules, and a user is judged by all of them.
//
// It FAILS CLOSED: a reply it does not recognise (no flags, no keys, no commands,
// a field of the wrong kind) is an error. Returned as an empty user it would read
// as "disabled, no keys", which is harmless, and that is the one thing an
// unrecognised reply must never be taken for.
func parseACLGetUser(name string, reply any) (ACLUserInfo, error) {
	info := ACLUserInfo{Name: name}
	fields := aclReplyFields(reply)
	flags, ok := fields["flags"].([]any)
	if !ok {
		return ACLUserInfo{}, fmt.Errorf("ACL GETUSER %s: the reply has no flags list (%T)", name, reply)
	}
	for _, f := range flags {
		if s, _ := f.(string); s == "on" {
			info.Enabled = true
		}
	}
	keys, hasKeys := fields["keys"]
	commands, hasCommands := fields["commands"].(string)
	if !hasKeys || !hasCommands {
		return ACLUserInfo{}, fmt.Errorf("ACL GETUSER %s: the reply has no keys or commands field", name)
	}
	info.KeyPatterns = aclKeyPatterns(keys)
	info.CommandRules = []string{commands}
	if sels, ok := fields["selectors"].([]any); ok {
		for _, s := range sels {
			sel := aclReplyFields(s)
			selCommands, ok := sel["commands"].(string)
			if _, hasSelKeys := sel["keys"]; !ok || !hasSelKeys {
				return ACLUserInfo{}, fmt.Errorf("ACL GETUSER %s: a selector has no keys or commands field", name)
			}
			info.KeyPatterns = append(info.KeyPatterns, aclKeyPatterns(sel["keys"])...)
			info.CommandRules = append(info.CommandRules, selCommands)
		}
	}
	return info, nil
}

func aclReplyFields(reply any) map[string]any {
	out := map[string]any{}
	switch v := reply.(type) {
	case map[any]any:
		for k, val := range v {
			if ks, ok := k.(string); ok {
				out[ks] = val
			}
		}
	case []any:
		for i := 0; i+1 < len(v); i += 2 {
			if ks, ok := v[i].(string); ok {
				out[ks] = v[i+1]
			}
		}
	}
	return out
}

// aclKeyPatterns splits a "keys" value: Redis 7 prints one string ("~a:* %R~b*"),
// older servers an array of bare patterns. "allkeys" is how Redis prints "~*".
func aclKeyPatterns(v any) []string {
	var out []string
	add := func(p string) {
		if p == "" {
			return
		}
		if p == "allkeys" || p == "*" {
			p = "~*"
		}
		if !strings.Contains(p, "~") {
			p = "~" + p
		}
		out = append(out, p)
	}
	switch k := v.(type) {
	case string:
		for p := range strings.FieldsSeq(k) {
			add(p)
		}
	case []any:
		for _, e := range k {
			if s, ok := e.(string); ok {
				add(s)
			}
		}
	}
	return out
}

// SharedCredentialLive dials the same endpoint twice without the provisioner's
// credentials: with none at all, and as the default user with a password nobody
// issued. Either succeeding means the shared path is still open. A refusal of
// both is necessary for an isolation claim and not sufficient (sharedPathLive).
func (g *goRedisProvisioner) SharedCredentialLive(ctx context.Context) (bool, string, error) {
	base := g.rdb.Options()
	probe := func(user, pass string) (bool, error) {
		o := *base
		o.Username, o.Password = user, pass
		o.CredentialsProvider, o.CredentialsProviderContext = nil, nil
		o.MaxRetries = -1
		c := redis.NewClient(&o)
		defer func() { _ = c.Close() }()
		err := c.Ping(ctx).Err()
		if err == nil {
			return true, nil
		}
		msg := err.Error()
		if strings.Contains(msg, "NOAUTH") || strings.Contains(msg, "WRONGPASS") || strings.Contains(msg, "NOPERM") ||
			strings.Contains(msg, "invalid username-password") || strings.Contains(msg, "Authentication required") {
			return false, nil
		}
		return false, err
	}
	live, err := probe("", "")
	if err != nil {
		return false, "", err
	}
	if live {
		return true, "a connection without credentials is accepted", nil
	}
	pw, err := newRedisPassword()
	if err != nil {
		return false, "", err
	}
	live, err = probe("default", pw)
	if err != nil {
		return false, "", err
	}
	if live {
		return true, "AUTH default accepts a password nobody issued", nil
	}
	return false, "", nil
}

func toAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}
