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

package metriccontract

import (
	"go/ast"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// The scope checks in register and constString are defense in depth: through
// Scan, the top-level allowlist refuses every local declaration in init()
// first, so no Scan fixture reaches them. These tests call the two resolvers
// directly on a parsed package, so removing either check still goes red.

// parseLocal parses one fixture file as package m and returns the package and
// the first call to MustRegister in it.
func parseLocal(t *testing.T, src string) (*pkg, *ast.CallExpr) {
	t.Helper()
	root := fixture(t, map[string]string{"internal/m/m.go": header + src})
	p, err := parsePackage(token.NewFileSet(), filepath.Join(root, "internal/m"), "example.com/op/internal/m", []string{"m.go"})
	if err != nil {
		t.Fatal(err)
	}
	var call *ast.CallExpr
	for _, f := range p.files {
		ast.Inspect(f, func(n ast.Node) bool {
			if c, ok := n.(*ast.CallExpr); ok && call == nil {
				if sel, ok := c.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "MustRegister" {
					call = c
				}
			}
			return call == nil
		})
	}
	if call == nil || len(call.Args) == 0 {
		t.Fatal("fixture has no MustRegister call with an argument")
	}
	return p, call
}

func TestRegisterRefusesACollectorThatResolvesToALocal(t *testing.T) {
	p, call := parseLocal(t, `
var c = prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_real_total"})

func init() {
	c := prometheus.NewCounter(prometheus.CounterOpts{Name: "knext_decoy_total"})
	metrics.Registry.MustRegister(c)
}
`)
	err := p.register(map[string]Family{}, call.Args[0], 0)
	if err == nil || !strings.Contains(err.Error(), "resolves to a local declaration") {
		t.Fatalf("register accepted a local that shadows the package var: %v", err)
	}
}

func TestConstStringRefusesANameBuiltFromALocalConst(t *testing.T) {
	p, call := parseLocal(t, `
const name = "knext_real_total"

func init() {
	const name = "knext_decoy_total"
	metrics.Registry.MustRegister(prometheus.NewCounter(prometheus.CounterOpts{Name: name}))
}
`)
	var nameExpr ast.Expr
	ast.Inspect(call.Args[0], func(n ast.Node) bool {
		if kv, ok := n.(*ast.KeyValueExpr); ok {
			if k, ok := kv.Key.(*ast.Ident); ok && k.Name == "Name" {
				nameExpr = kv.Value
			}
		}
		return nameExpr == nil
	})
	if nameExpr == nil {
		t.Fatal("fixture has no Name field")
	}
	_, err := p.constString(nameExpr, 0)
	if err == nil || !strings.Contains(err.Error(), "resolves to a local declaration") {
		t.Fatalf("constString accepted a local const that shadows the package const: %v", err)
	}
}
