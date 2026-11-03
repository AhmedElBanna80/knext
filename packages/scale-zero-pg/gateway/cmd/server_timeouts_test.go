package cmd_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// timeUnits are the time.Duration constants whose value is known.
var timeUnits = map[string]float64{
	"Nanosecond": 1, "Microsecond": 1e3, "Millisecond": 1e6,
	"Second": 1e9, "Minute": 60e9, "Hour": 3600e9,
}

// constValue evaluates e as a constant built only from numeric literals,
// time.<Unit> selectors, parentheses and + - * /. ok is false for anything
// else (identifiers, calls, ...), which the scan cannot verify.
func constValue(e ast.Expr, timePkg string) (float64, bool) {
	switch x := e.(type) {
	case *ast.BasicLit:
		if x.Kind != token.INT && x.Kind != token.FLOAT {
			return 0, false
		}
		v, err := strconv.ParseFloat(strings.ReplaceAll(x.Value, "_", ""), 64)
		if err != nil {
			return 0, false
		}
		return v, true
	case *ast.ParenExpr:
		return constValue(x.X, timePkg)
	case *ast.SelectorExpr:
		id, ok := x.X.(*ast.Ident)
		if !ok || timePkg == "" || id.Name != timePkg {
			return 0, false
		}
		v, ok := timeUnits[x.Sel.Name]
		return v, ok
	case *ast.BinaryExpr:
		l, ok1 := constValue(x.X, timePkg)
		r, ok2 := constValue(x.Y, timePkg)
		if !ok1 || !ok2 {
			return 0, false
		}
		switch x.Op {
		case token.ADD:
			return l + r, true
		case token.SUB:
			return l - r, true
		case token.MUL:
			return l * r, true
		case token.QUO:
			if r == 0 {
				return 0, false
			}
			return l / r, true
		}
	}
	return 0, false
}

// importNames returns the local names of net/http and time in f, and a
// problem string if net/http is dot-imported (unverifiable).
func importNames(f *ast.File) (httpName, timeName, problem string) {
	for _, im := range f.Imports {
		p, _ := strconv.Unquote(im.Path.Value)
		name := ""
		if im.Name != nil {
			name = im.Name.Name
		}
		switch p {
		case "net/http":
			switch name {
			case ".":
				problem = "dot import of net/http cannot be verified"
			case "_":
			case "":
				httpName = "http"
			default:
				httpName = name
			}
		case "time":
			if name == "" {
				timeName = "time"
			} else if name != "_" && name != "." {
				timeName = name
			}
		}
	}
	return
}

// scanSource returns the problems found in one Go source file: every
// net/http Server must be a keyed literal whose ReadHeaderTimeout is a
// verifiable non-zero constant; forms that cannot carry or prove a timeout
// are reported. servers counts the net/http Server literals seen.
func scanSource(fset *token.FileSet, path string, src any) (problems []string, servers int) {
	f, err := parser.ParseFile(fset, path, src, 0)
	if err != nil {
		return []string{fmt.Sprintf("%s: unparseable, cannot verify server timeouts: %v", path, err)}, 0
	}
	httpName, timeName, prob := importNames(f)
	if prob != "" {
		return []string{path + ": " + prob}, 0
	}
	if httpName == "" {
		return nil, 0
	}
	isServer := func(e ast.Expr) bool {
		s, ok := e.(*ast.SelectorExpr)
		if !ok {
			return false
		}
		id, ok := s.X.(*ast.Ident)
		return ok && id.Name == httpName && s.Sel.Name == "Server"
	}
	ast.Inspect(f, func(n ast.Node) bool {
		bad := func(format string, a ...any) {
			problems = append(problems, fset.Position(n.Pos()).String()+": "+fmt.Sprintf(format, a...))
		}
		switch x := n.(type) {
		case *ast.CompositeLit:
			if !isServer(x.Type) {
				return true
			}
			servers++
			found := false
			for _, el := range x.Elts {
				kv, ok := el.(*ast.KeyValueExpr)
				if !ok {
					bad("http.Server literal has non-keyed fields; cannot verify")
					return true
				}
				if k, ok := kv.Key.(*ast.Ident); ok && k.Name == "ReadHeaderTimeout" {
					found = true
					v, ok := constValue(kv.Value, timeName)
					if !ok {
						bad("ReadHeaderTimeout is not a verifiable constant")
					} else if v <= 0 {
						bad("ReadHeaderTimeout is zero or negative")
					}
				}
			}
			if !found {
				bad("http.Server literal lacks ReadHeaderTimeout")
			}
		case *ast.ValueSpec:
			if x.Type != nil && isServer(x.Type) {
				bad("zero-value http.Server declaration; use a literal with ReadHeaderTimeout")
			}
		case *ast.CallExpr:
			if id, ok := x.Fun.(*ast.Ident); ok && id.Name == "new" && len(x.Args) == 1 && isServer(x.Args[0]) {
				bad("new(http.Server) carries no timeouts")
			}
			if s, ok := x.Fun.(*ast.SelectorExpr); ok {
				if p, ok := s.X.(*ast.Ident); ok && p.Name == httpName {
					switch s.Sel.Name {
					case "ListenAndServe", "ListenAndServeTLS", "Serve", "ServeTLS":
						bad("http.%s bypasses an http.Server literal; build a server with ReadHeaderTimeout", s.Sel.Name)
					}
				}
			}
		}
		return true
	})
	return problems, servers
}

func TestScanSourceFixtures(t *testing.T) {
	cases := []struct {
		name, src string
		wantBad   bool
	}{
		{"valid", `package p
import ("net/http"; "time")
var _ = &http.Server{Addr: ":1", ReadHeaderTimeout: 5 * time.Second}
`, false},
		{"valid aliased", `package p
import (h "net/http"; t "time")
var _ = &h.Server{ReadHeaderTimeout: 2 * t.Second}
`, false},
		{"zero literal", `package p
import "net/http"
var _ = &http.Server{ReadHeaderTimeout: 0}
`, true},
		{"zero product", `package p
import ("net/http"; "time")
var _ = &http.Server{ReadHeaderTimeout: 0 * time.Second}
`, true},
		{"non-constant ident", `package p
import "net/http"
var d int64
var _ = &http.Server{ReadHeaderTimeout: d}
`, true},
		{"non-constant call", `package p
import "net/http"
func f() int64 { return 1 }
var _ = &http.Server{ReadHeaderTimeout: f()}
`, true},
		{"missing key", `package p
import "net/http"
var _ = &http.Server{Addr: ":1"}
`, true},
		{"aliased import literal missing key", `package p
import h "net/http"
var _ = &h.Server{Addr: ":1"}
`, true},
		{"aliased import ListenAndServe", `package p
import h "net/http"
func f() { h.ListenAndServe(":1", nil) }
`, true},
		{"dot import", `package p
import . "net/http"
var _ = &Server{Addr: ":1"}
`, true},
		{"plain ListenAndServe", `package p
import "net/http"
func f() { http.ListenAndServe(":1", nil) }
`, true},
		{"http ident that is not net/http", `package p
import http "example.com/myhttp"
func f() { http.ListenAndServe(":1", nil) }
`, false},
		{"unparseable", `package p func`, true},
	}
	for _, c := range cases {
		got, _ := scanSource(token.NewFileSet(), "fixture.go", c.src)
		if (len(got) > 0) != c.wantBad {
			t.Errorf("%s: wantBad=%v got problems %v", c.name, c.wantBad, got)
		}
	}
}

// TestEveryHTTPServerSetsReadHeaderTimeout scans every non-test Go file under
// cmd/ and fails on any http.Server without a verifiable non-zero
// ReadHeaderTimeout, or built in a form this scan cannot verify.
func TestEveryHTTPServerSetsReadHeaderTimeout(t *testing.T) {
	fset := token.NewFileSet()
	files, servers := 0, 0
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		files++
		probs, n := scanSource(fset, path, nil)
		servers += n
		for _, p := range probs {
			t.Error(p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if files == 0 || servers == 0 {
		t.Fatalf("scan found files=%d servers=%d; guard is not seeing the tree", files, servers)
	}
}
