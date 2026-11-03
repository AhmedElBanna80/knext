package wake

import (
	"context"
	"net"
	"strconv"
	"testing"
	"time"
)

// TestReservedColdTargetIsNotStealable guards the reserve-then-rebind race in
// the single-flight test helpers: between reserveColdTarget and the driver's
// Wake, the port must stay owned by the reservation, so neither another
// listener nor an ephemeral outbound source port can take it (EADDRINUSE).
// While reserved the target must still look ASLEEP (a dial is refused), and the
// driver's Wake must still be able to bring it up on exactly that port.
func TestReservedColdTargetIsNotStealable(t *testing.T) {
	tgt := reserveColdTarget(t, "reserved")
	addr := net.JoinHostPort(tgt.Host, strconv.Itoa(tgt.Port))

	// A third party binding the reserved port must fail: the reservation holds it.
	if ln, err := net.Listen("tcp", addr); err == nil {
		_ = ln.Close()
		t.Fatalf("reserved port %s was bindable by a third party (close->rebind window still open)", addr)
	}

	// The compute must still look asleep: a dial is refused, not accepted/hung.
	if c, err := net.DialTimeout("tcp", addr, 200*time.Millisecond); err == nil {
		_ = c.Close()
		t.Fatalf("reserved port %s accepted a connection before Wake (compute not asleep)", addr)
	}

	// Wake claims the reservation and the target becomes reachable on that port.
	drv := newColdWakeDriver(0)
	defer drv.closeAll()
	if err := drv.Wake(context.Background(), tgt); err != nil {
		t.Fatalf("Wake on a reserved target: %v", err)
	}
	c, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatalf("dial after Wake: %v", err)
	}
	_ = c.Close()
}
