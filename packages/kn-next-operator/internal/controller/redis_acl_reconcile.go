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
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	platformv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/platform/v1alpha1"
	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
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
	// used before the refusal is observed.
	cacheSharedLiveMessage = "isolation not in force: shared credential live"

	cacheResyncInterval = 5 * time.Minute
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
	// KeyPatterns returns the key patterns of one user (ACL GETUSER keys).
	KeyPatterns(ctx context.Context, username string) ([]string, error)
	// SharedCredentialLive reports whether the endpoint still accepts a
	// connection that presents no credential, or the default user with a
	// password nobody issued. detail names which.
	SharedCredentialLive(ctx context.Context) (live bool, detail string, err error)
	Close() error
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

var derivedPrefixRe = regexp.MustCompile(`^kn-[0-9a-f]{12}$`)

// reservedCachePrefix reports ADR-0071 D6a rules 0 and 1 for an app's prefix.
func reservedCachePrefix(app *appsv1alpha1.NextApp, prefix string) string {
	if prefix == "knext" || strings.HasPrefix(prefix, "knext:") {
		return fmt.Sprintf("keyPrefix %q is reserved for the platform keyspace", prefix)
	}
	if derivedPrefixRe.MatchString(prefix) && prefix != defaultRedisKeyPrefix(app) {
		return fmt.Sprintf("keyPrefix %q is in the range derived for other apps and is not this app's own", prefix)
	}
	return ""
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
// It never returns an error for a condition the app can be told about; those
// are the state's reason. A returned error is a transient failure to retry.
func (r *NextAppReconciler) reconcileCacheCredentials(ctx context.Context, app *appsv1alpha1.NextApp, snap platformSnapshot) (cacheCredentialsState, error) {
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

	if redisURLHasUserinfo(app.Spec.Cache.URL) {
		return fail(ReasonCacheSharedCredentialInSpec,
			"spec.cache.url carries credentials; an isolated app gets its credential from the operator-owned Secret")
	}
	if app.Spec.Secrets != nil {
		if e, ok := app.Spec.Secrets.EnvMap["REDIS_URL"]; ok && e.SecretName != st.secretName {
			return fail(ReasonCacheSharedCredentialInSpec,
				"spec.secrets.envMap sets REDIS_URL; an isolated app gets it from the operator-owned Secret")
		}
	}
	prefix := operatorRedisKeyPrefix(app)
	if prefix == "" {
		return fail(ReasonCachePrefixUnknown,
			"the app's Redis key prefix is not known to the operator (set spec.cache.keyPrefix)")
	}
	if why := reservedCachePrefix(app, prefix); why != "" {
		return fail(ReasonCachePrefixReserved, why)
	}

	identity, err := r.clusterIdentity(ctx, snap)
	if err != nil {
		return st, err
	}
	st.username = redisACLUsername(identity, app)

	provURL, err := r.provisionerURL(ctx, ep)
	if err != nil {
		return fail(ReasonCacheProvisionerRefused, "the provisioner credential cannot be read: "+err.Error())
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

	// D6a: a user already on the endpoint whose key pattern overlaps ours is a
	// conflict, orphans and other clusters' users included. Whoever holds a user
	// first keeps it; the second claimant fails closed and never creates one.
	conflict, err := prefixConflict(ctx, prov, st.username, prefix)
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

	st.failClosed = false
	st.ready = true
	live, detail, perr := prov.SharedCredentialLive(ctx)
	switch {
	case perr != nil:
		st.reason, st.message = ReasonCacheSharedCredentialLive, cacheSharedLiveMessage+" (the probe failed: "+redactErr(perr)+")"
	case live:
		st.reason, st.message = ReasonCacheSharedCredentialLive, cacheSharedLiveMessage+" ("+detail+")"
	default:
		st.reason = ReasonCacheProvisioned
		st.message = "the app runs under its own ACL user and the endpoint refuses the shared credential"
	}
	return st, nil
}

func failClosedCache(app *appsv1alpha1.NextApp, reason, msg string) cacheCredentialsState {
	return cacheCredentialsState{
		active: true, failClosed: true, reason: reason, message: msg,
		secretName: redisCredentialsSecretName(app),
	}
}

func redisMajor(version string) int {
	head, _, _ := strings.Cut(version, ".")
	n, err := strconv.Atoi(strings.TrimSpace(head))
	if err != nil {
		return 0
	}
	return n
}

// redactErr keeps a Redis error from carrying a URL with a password.
func redactErr(err error) string {
	s := err.Error()
	return regexp.MustCompile(`redis(s)?://[^\s]*@`).ReplaceAllString(s, "redis$1://***@")
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
		pats, err := prov.KeyPatterns(ctx, u)
		if err != nil {
			return "", err
		}
		for _, p := range pats {
			other, ok := patternPrefix(p)
			if !ok || prefixesOverlap(prefix, other) {
				return fmt.Sprintf("another ACL user on the endpoint already covers keys under %q; "+
					"an app's key prefix must not equal, nest inside, or contain another app's", prefix), nil
			}
		}
	}
	return "", nil
}

func (r *NextAppReconciler) reader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

func (r *NextAppReconciler) provisionerURL(ctx context.Context, ep platformv1alpha1.RedisEndpoint) (string, error) {
	var sec corev1.Secret
	key := types.NamespacedName{Namespace: operatorNamespace(), Name: ep.ProvisionerSecretRef.Name}
	if err := r.reader().Get(ctx, key, &sec); err != nil {
		return "", fmt.Errorf("get Secret %s/%s: %w", key.Namespace, key.Name, err)
	}
	v, ok := sec.Data[ep.ProvisionerSecretRef.Key]
	if !ok || len(v) == 0 {
		return "", fmt.Errorf("Secret %s/%s has no key %q", key.Namespace, key.Name, ep.ProvisionerSecretRef.Key)
	}
	return strings.TrimSpace(string(v)), nil
}

// errCredentialsSecretForeign: the reserved Secret name is taken by an object
// this NextApp does not control (a squatter, or a leftover from an earlier app of
// the same name). It is never written.
var errCredentialsSecretForeign = errors.New("the Secret name is held by an object this NextApp does not control")

// ensureCredentialsSecret creates the operator-owned Secret on first use and
// returns the current password. An existing, well-formed Secret is reused, so a
// reconcile never changes the password (rotation is a separate step).
func (r *NextAppReconciler) ensureCredentialsSecret(ctx context.Context, app *appsv1alpha1.NextApp, canonical, username string) (string, error) {
	scheme := "redis"
	if u, err := url.Parse(app.Spec.Cache.URL); err == nil && u.Scheme == "rediss" {
		scheme = "rediss"
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
	for k, v := range app.Spec.Secrets.EnvMap {
		m[k] = v
	}
	m["REDIS_URL"] = appsv1alpha1.EnvMapEntry{SecretName: st.secretName, SecretKey: redisCredentialsSecretKey}
	app.Spec.Secrets.EnvMap = m
}

// cacheStatusFor is status.cache for one pass.
func cacheStatusFor(st cacheCredentialsState) *appsv1alpha1.CacheStatus {
	if !st.active || !st.ready {
		return nil
	}
	return &appsv1alpha1.CacheStatus{Isolation: "acl", Username: st.username, SecretName: st.secretName}
}

// cleanupIsolatedCache is the finalizer's half (D7): sweep the app's keys as the
// app's own user, then ACL DELUSER with the provisioner credential. Best-effort
// like the rest of the cleanup; a failure is returned for the caller to warn on.
func (r *NextAppReconciler) cleanupIsolatedCache(ctx context.Context, app *appsv1alpha1.NextApp, keyPrefix string) error {
	logger := logf.FromContext(ctx)
	snap, err := r.loadPlatform(ctx)
	if err != nil {
		return err
	}
	canonical, cerr := canonicalRedisEndpoint(app.Spec.Cache.URL, app.Namespace)
	if cerr != nil {
		return cerr
	}
	ep, ok := registeredEndpoint(snap, canonical)
	if !ok {
		return errors.New("endpoint is no longer registered; the ACL user is left in place")
	}
	var sec corev1.Secret
	if err := r.reader().Get(ctx, client.ObjectKey{Namespace: app.Namespace, Name: redisCredentialsSecretName(app)}, &sec); err != nil {
		if apierrors.IsNotFound(err) {
			return nil // never provisioned
		}
		return err
	}
	if appURL := string(sec.Data[redisCredentialsSecretKey]); appURL != "" && r.Cleaner != nil {
		if err := r.Cleaner.CleanupCache(ctx, CacheTarget{Provider: "redis", URL: appURL, KeyPrefix: keyPrefix}); err != nil {
			logger.Error(err, "sweeping the isolated keyspace as the app user failed", "keyPrefix", keyPrefix)
		}
	}
	identity, err := r.clusterIdentity(ctx, snap)
	if err != nil {
		return err
	}
	provURL, err := r.provisionerURL(ctx, ep)
	if err != nil {
		return err
	}
	prov, err := r.redisDialer()(ctx, provURL)
	if err != nil {
		return err
	}
	defer func() { _ = prov.Close() }()
	return prov.DelUser(ctx, redisACLUsername(identity, app))
}

// Cluster identity (ADR-0071 D2): the kube-system Namespace uid, read only when
// KnextPlatform spec.cache.clusterId is unset. Nothing else about Namespaces.
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get

// ── go-redis implementation ─────────────────────────────────────────────────

type goRedisProvisioner struct{ rdb *redis.Client }

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
	return &goRedisProvisioner{rdb: rdb}, nil
}

func (g *goRedisProvisioner) Close() error { return g.rdb.Close() }

func (g *goRedisProvisioner) Version(ctx context.Context) (string, error) {
	info, err := g.rdb.Info(ctx, "server").Result()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(info, "\n") {
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

func (g *goRedisProvisioner) KeyPatterns(ctx context.Context, username string) ([]string, error) {
	res, err := g.rdb.Do(ctx, "ACL", "GETUSER", username).Result()
	if err != nil {
		return nil, err
	}
	var keys string
	switch v := res.(type) {
	case map[any]any:
		keys, _ = v["keys"].(string)
	case []any:
		for i := 0; i+1 < len(v); i += 2 {
			if k, _ := v[i].(string); k == "keys" {
				keys, _ = v[i+1].(string)
			}
		}
	}
	// "allkeys" is how Redis prints "~*"; it covers everything.
	if strings.TrimSpace(keys) == "" {
		return nil, nil
	}
	return strings.Fields(strings.ReplaceAll(keys, "allkeys", "~*")), nil
}

// SharedCredentialLive dials the same endpoint twice without the provisioner's
// credentials: with none at all, and as the default user with a password nobody
// issued. Either succeeding means the shared path is still open.
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
