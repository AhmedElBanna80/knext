package wake

import (
	"context"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// coldWakeDriver models a set of computes that start ASLEEP (no listener -> a dial
// is refused) and become WARM when Wake opens a listener on the target's port. It
// counts Wake calls per key and blocks briefly inside Wake so concurrent callers
// pile up on the same in-flight wake (forcing the single-flight overlap under test).
type coldWakeDriver struct {
	mu        sync.Mutex
	listeners map[string]net.Listener
	block     time.Duration
	wakes     int32 // total Wake invocations across all keys (atomic)

	perKeyMu sync.Mutex
	perKey   map[string]int
}

func newColdWakeDriver(block time.Duration) *coldWakeDriver {
	return &coldWakeDriver{
		listeners: map[string]net.Listener{},
		block:     block,
		perKey:    map[string]int{},
	}
}

func (d *coldWakeDriver) Mode() string { return "cold-fake" }

func (d *coldWakeDriver) Resolve(string) Target { return Target{} }

func (d *coldWakeDriver) Wake(_ context.Context, t Target) error {
	atomic.AddInt32(&d.wakes, 1)
	d.perKeyMu.Lock()
	d.perKey[t.Key]++
	d.perKeyMu.Unlock()
	if d.block > 0 {
		time.Sleep(d.block) // hold the wake in flight so followers coalesce onto it
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, up := d.listeners[t.Key]; up {
		return nil
	}
	ln, err := listenReserved(t.Host, t.Port)
	if err != nil {
		return err
	}
	// Accept-and-close: a live compute answers TryConnect; the gateway then pipes.
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			_ = c.Close()
		}
	}()
	d.listeners[t.Key] = ln
	return nil
}

func (*coldWakeDriver) Sleep(context.Context, Target) error { return nil }
func (*coldWakeDriver) CanSleep() bool                      { return true }

func (d *coldWakeDriver) closeAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, ln := range d.listeners {
		_ = ln.Close()
	}
}

func (d *coldWakeDriver) wakesFor(key string) int {
	d.perKeyMu.Lock()
	defer d.perKeyMu.Unlock()
	return d.perKey[key]
}

// reserveColdTarget reserves a free localhost port and returns a Target for it
// while leaving nothing LISTENING on it — so an initial TryConnect is refused
// (compute asleep) until the driver's Wake brings a listener up on it. The port
// stays reserved (see reservePort) until Wake claims it via listenReserved, so
// there is no close->rebind window for another process to steal it.
func reserveColdTarget(t *testing.T, key string) Target {
	t.Helper()
	host, port := reservePort(t)
	return Target{Host: host, Port: port, Key: key}
}

// TestConcurrentColdWakeIsSingleFlighted: N goroutines wake the SAME cold key
// concurrently -> exactly ONE scale write (Wake) and ONE wake-budget token
// consumed; all N callers connect successfully. Without coalescing every caller
// runs its own wake (N scale writes / N tokens) — this is the #1018 thundering herd.
func TestConcurrentColdWakeIsSingleFlighted(t *testing.T) {
	const n = 20
	drv := newColdWakeDriver(50 * time.Millisecond)
	defer drv.closeAll()
	tgt := reserveColdTarget(t, "orders")

	// A generous budget: the point is that ONE token is consumed for the whole
	// group, not that the budget is hit. guardCalls counts token consumption.
	lim := NewWakeLimiter(100, time.Minute)
	var guardCalls int32
	opts := Opts{
		ConnectTimeoutMs: 200,
		WakeTimeoutMs:    5000,
		RetryMs:          10,
		WakeGuard: func(key string) error {
			atomic.AddInt32(&guardCalls, 1)
			if lim.Allow(key) {
				return nil
			}
			return ErrWakeBudgetExceeded
		},
		Coalescer: NewWakeCoalescer(),
	}

	var wg sync.WaitGroup
	errs := make([]error, n)
	conns := make([]net.Conn, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			c, _, _, err := ConnectWithWake(context.Background(), drv, tgt, opts, nil)
			conns[i] = c
			errs[i] = err
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("caller %d failed: %v", i, err)
		}
		if conns[i] == nil {
			t.Fatalf("caller %d got a nil conn", i)
		}
		_ = conns[i].Close()
	}
	if got := atomic.LoadInt32(&drv.wakes); got != 1 {
		t.Fatalf("scale writes (Wake calls) = %d, want exactly 1 (coalesced)", got)
	}
	if got := atomic.LoadInt32(&guardCalls); got != 1 {
		t.Fatalf("wake-budget tokens consumed = %d, want exactly 1 (coalesced)", got)
	}
}

// TestDistinctKeysNotCoalesced: two DIFFERENT cold computes must wake
// independently — coalescing is per-key, never a global lock.
func TestDistinctKeysNotCoalesced(t *testing.T) {
	drv := newColdWakeDriver(30 * time.Millisecond)
	defer drv.closeAll()
	a := reserveColdTarget(t, "orders")
	b := reserveColdTarget(t, "billing")

	coalescer := NewWakeCoalescer()
	opts := Opts{
		ConnectTimeoutMs: 200,
		WakeTimeoutMs:    5000,
		RetryMs:          10,
		Coalescer:        coalescer,
	}

	var wg sync.WaitGroup
	dial := func(tgt Target) {
		defer wg.Done()
		c, _, _, err := ConnectWithWake(context.Background(), drv, tgt, opts, nil)
		if err != nil {
			t.Errorf("wake %s: %v", tgt.Key, err)
			return
		}
		_ = c.Close()
	}
	// Several callers per key, both keys concurrent.
	for i := 0; i < 5; i++ {
		wg.Add(2)
		go dial(a)
		go dial(b)
	}
	wg.Wait()

	if got := drv.wakesFor("orders"); got != 1 {
		t.Fatalf("orders wakes = %d, want 1 (its own coalesced group)", got)
	}
	if got := drv.wakesFor("billing"); got != 1 {
		t.Fatalf("billing wakes = %d, want 1 (its own coalesced group)", got)
	}
	if got := atomic.LoadInt32(&drv.wakes); got != 2 {
		t.Fatalf("total wakes = %d, want 2 (distinct keys not coalesced)", got)
	}
}

// blockingWakeDriver holds Wake until release is closed, so a leader wake can be
// pinned in flight while a follower's ctx is cancelled underneath it. On release it
// binds a listener on tgt so the leader's post-wake TryConnect succeeds promptly
// (rather than polling to WakeTimeoutMs).
type blockingWakeDriver struct {
	tgt     Target
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	wakes   int32 // total Wake invocations (atomic) — one per coalesced group

	mu sync.Mutex
	ln net.Listener
}

func (*blockingWakeDriver) Mode() string            { return "blocking-fake" }
func (d *blockingWakeDriver) Resolve(string) Target { return d.tgt }
func (d *blockingWakeDriver) Wake(ctx context.Context, t Target) error {
	atomic.AddInt32(&d.wakes, 1)
	d.once.Do(func() { close(d.entered) })
	select {
	case <-d.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ln != nil {
		return nil
	}
	ln, err := listenReserved(t.Host, t.Port)
	if err != nil {
		return err
	}
	go func() {
		for {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			_ = c.Close()
		}
	}()
	d.ln = ln
	return nil
}
func (*blockingWakeDriver) Sleep(context.Context, Target) error { return nil }
func (*blockingWakeDriver) CanSleep() bool                      { return true }
func (d *blockingWakeDriver) closeAll() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.ln != nil {
		_ = d.ln.Close()
	}
}

// TestWaitingWakerAbortsOnCtxCancel: a follower whose ctx is cancelled while the
// LEADER's wake is still in flight returns the ctx error PROMPTLY (no hang) — the
// #1017 drain-abort regression guard. The leader is NOT disturbed by the follower's
// cancellation (singleflight shares the leader's call).
func TestWaitingWakerAbortsOnCtxCancel(t *testing.T) {
	tgt := reserveColdTarget(t, "k")
	drv := &blockingWakeDriver{tgt: tgt, entered: make(chan struct{}), release: make(chan struct{})}
	defer drv.closeAll()
	coalescer := NewWakeCoalescer()
	opts := Opts{
		ConnectTimeoutMs: 50,
		WakeTimeoutMs:    60000, // long, so only ctx-cancel can end the follower's wait
		RetryMs:          10,
		Coalescer:        coalescer,
	}

	// Leader: a long-lived ctx, pinned inside Wake.
	leaderDone := make(chan struct{})
	go func() {
		defer close(leaderDone)
		_, _, _, _ = ConnectWithWake(context.Background(), drv, tgt, opts, nil)
	}()
	select {
	case <-drv.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("leader never entered Wake")
	}

	// Follower: cancel its ctx while the leader's wake is in flight; it must return
	// the ctx error within a tight bound rather than blocking to WakeTimeoutMs.
	fctx, cancel := context.WithCancel(context.Background())
	got := make(chan error, 1)
	go func() {
		_, _, _, err := ConnectWithWake(fctx, drv, tgt, opts, nil)
		got <- err
	}()
	cancel()
	select {
	case err := <-got:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("follower err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("follower hung past its cancelled ctx (drain-abort regression)")
	}

	// Release the leader so the test does not leak the goroutine.
	close(drv.release)
	<-leaderDone
}

// TestLeaderDepartureLetsFollowersRecover: the coalesced wake is bound to the
// LEADER's ctx (deliberate — it is what lets a #1017 drain force-close cancel an
// in-flight coalesced wake, a graceful-shutdown invariant). This guards the
// CONSEQUENCE: if the LEADER client disconnects mid-wake, its ctx cancels and the
// healthy FOLLOWERS waiting on that key receive the leader's cancel error — a
// spurious TRANSIENT failure, NOT a permanent one. The group self-heals:
// singleflight forgets the key on the leader's return, so a fresh attempt elects a
// NEW leader and wakes successfully, and each coalesced group consumes exactly ONE
// budget token (no per-follower charge, no leak, no poisoned/cached result).
//
// This is the leader-departure direction; TestWaitingWakerAbortsOnCtxCancel covers
// the inverse (a FOLLOWER cancels; the leader is undisturbed).
func TestLeaderDepartureLetsFollowersRecover(t *testing.T) {
	const followers = 8
	tgt := reserveColdTarget(t, "orders")
	drv := &blockingWakeDriver{tgt: tgt, entered: make(chan struct{}), release: make(chan struct{})}
	defer drv.closeAll()

	coalescer := NewWakeCoalescer()
	// A generous budget: the ONLY reason a wake fails here is the leader's cancel, and
	// guardCalls cleanly counts token consumption per coalesced group.
	lim := NewWakeLimiter(100, time.Minute)
	var guardCalls int32
	opts := Opts{
		ConnectTimeoutMs: 50,
		WakeTimeoutMs:    60000, // long: only the leader's ctx-cancel ends the wake
		RetryMs:          10,
		WakeGuard: func(key string) error {
			atomic.AddInt32(&guardCalls, 1)
			if lim.Allow(key) {
				return nil
			}
			return ErrWakeBudgetExceeded
		},
		Coalescer: coalescer,
	}

	// Leader: a cancellable ctx, pinned inside Wake so it holds the singleflight group
	// open while the followers pile on.
	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderErr := make(chan error, 1)
	go func() {
		_, _, _, err := ConnectWithWake(leaderCtx, drv, tgt, opts, nil)
		leaderErr <- err
	}()
	select {
	case <-drv.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("leader never entered Wake")
	}

	// Followers: healthy (background) ctxs. Because the leader still holds the
	// in-flight group, any follower that reaches DoChan JOINS it — singleflight
	// guarantees a caller cannot lead a key whose call is still in flight — rather
	// than starting its own wake.
	var started sync.WaitGroup
	started.Add(followers)
	followerErr := make([]error, followers)
	var fwg sync.WaitGroup
	fwg.Add(followers)
	for i := 0; i < followers; i++ {
		go func(i int) {
			defer fwg.Done()
			started.Done()
			_, _, _, err := ConnectWithWake(context.Background(), drv, tgt, opts, nil)
			followerErr[i] = err
		}(i)
	}
	started.Wait()
	// Let every follower get past its (instant, connection-refused) TryConnect and
	// register on the leader's group before the leader departs. While the leader is
	// pinned in Wake the group cannot be forgotten, so this settle only needs to cover
	// goroutine scheduling; a follower that had instead led would bump guardCalls>1,
	// which the assertion below catches rather than silently passing.
	time.Sleep(150 * time.Millisecond)
	if got := atomic.LoadInt32(&guardCalls); got != 1 {
		t.Fatalf("pre-cancel wake-budget tokens = %d, want exactly 1 (leader only; followers coalesced, none led)", got)
	}

	// The LEADER disconnects mid-wake: cancel its ctx. The coalesced wake (bound to
	// the leader's ctx) fails, and that single shared cancel reaches every follower.
	cancelLeader()

	// The leader itself returns a cancellation error, bounded (no hang).
	select {
	case err := <-leaderErr:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("leader err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("leader hung past its cancelled ctx")
	}

	// Every healthy follower gets the leader's cancel — a CLEAN, retryable transient,
	// not a permanent failure and not a hang.
	done := make(chan struct{})
	go func() { fwg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("followers hung after leader departure (should get the shared cancel promptly)")
	}
	for i, err := range followerErr {
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("follower %d err = %v, want a transient context.Canceled (leader departed mid-wake)", i, err)
		}
	}

	// Exactly ONE token was consumed for the orphaned group — the leader's. No
	// follower consumed a token and nothing double-charged: coalesced accounting is
	// intact even though the group FAILED (one Wake attempt, one budget token).
	if got := atomic.LoadInt32(&guardCalls); got != 1 {
		t.Fatalf("post-departure wake-budget tokens = %d, want exactly 1 (one coalesced group)", got)
	}
	if got := atomic.LoadInt32(&drv.wakes); got != 1 {
		t.Fatalf("post-departure scale writes = %d, want exactly 1 (one coalesced Wake)", got)
	}

	// RECOVERY: the key was forgotten on the leader's return, so a fresh attempt
	// elects a NEW leader and wakes successfully. Release the driver so the recovery
	// wake binds its listener and the connect completes promptly.
	close(drv.release)
	rctx, rcancel := context.WithCancel(context.Background())
	defer rcancel()
	conn, woke, _, err := ConnectWithWake(rctx, drv, tgt, opts, nil)
	if err != nil {
		t.Fatalf("recovery wake failed: %v (followers did not recover after leader departure)", err)
	}
	if conn == nil {
		t.Fatal("recovery wake returned a nil conn")
	}
	_ = conn.Close()
	if !woke {
		t.Fatal("recovery expected woke=true (a fresh cold wake), got the warm fast path — the departed leader left a stale/cached state")
	}

	// The recovery is a FRESH coalesced group: it consumed its OWN single token
	// (total 2) and issued its OWN single scale write (total 2). No stale success or
	// poisoned error was cached from the departed leader.
	if got := atomic.LoadInt32(&guardCalls); got != 2 {
		t.Fatalf("post-recovery wake-budget tokens = %d, want 2 (departed group + fresh recovery group)", got)
	}
	if got := atomic.LoadInt32(&drv.wakes); got != 2 {
		t.Fatalf("post-recovery scale writes = %d, want 2 (departed group + fresh recovery group)", got)
	}
}
