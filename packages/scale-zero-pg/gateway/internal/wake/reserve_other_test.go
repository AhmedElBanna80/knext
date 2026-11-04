//go:build !unix

package wake

import (
	"net"
	"strconv"
	"testing"
)

// Non-unix fallback: the original close->rebind reservation. It keeps the test
// package compiling off unix; the race-free version lives in reserve_unix_test.go
// and the gateway only ships on linux.
func reservePort(t *testing.T) (string, int) {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	host, portStr, _ := net.SplitHostPort(probe.Addr().String())
	port, _ := strconv.Atoi(portStr)
	_ = probe.Close()
	return host, port
}

func listenReserved(host string, port int) (net.Listener, error) {
	return net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
}
