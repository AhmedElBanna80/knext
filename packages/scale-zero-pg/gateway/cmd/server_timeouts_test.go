package cmd_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// isHTTPServer reports whether e is the selector http.Server.
func isHTTPServer(e ast.Expr) bool {
	s, ok := e.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	id, ok := s.X.(*ast.Ident)
	return ok && id.Name == "http" && s.Sel.Name == "Server"
}

// TestEveryHTTPServerSetsReadHeaderTimeout scans every non-test Go file under
// cmd/ and fails if an http.Server is built without ReadHeaderTimeout, or in a
// form this scan cannot verify (zero-value var, new(http.Server), positional
// literal, package-level http.ListenAndServe/Serve which cannot carry timeouts).
// Unparseable files fail rather than pass.
func TestEveryHTTPServerSetsReadHeaderTimeout(t *testing.T) {
	fset := token.NewFileSet()
	files := 0
	servers := 0
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			t.Errorf("%s: unparseable, cannot verify server timeouts: %v", path, perr)
			return nil
		}
		files++
		ast.Inspect(f, func(n ast.Node) bool {
			pos := func() string { return fset.Position(n.Pos()).String() }
			switch x := n.(type) {
			case *ast.CompositeLit:
				if !isHTTPServer(x.Type) {
					return true
				}
				servers++
				found := false
				for _, el := range x.Elts {
					kv, ok := el.(*ast.KeyValueExpr)
					if !ok {
						t.Errorf("%s: http.Server literal has non-keyed fields; cannot verify", pos())
						return true
					}
					if k, ok := kv.Key.(*ast.Ident); ok && k.Name == "ReadHeaderTimeout" {
						found = true
					}
				}
				if !found {
					t.Errorf("%s: http.Server literal lacks ReadHeaderTimeout", pos())
				}
			case *ast.ValueSpec:
				if isHTTPServer(x.Type) {
					t.Errorf("%s: zero-value http.Server declaration; use a literal with ReadHeaderTimeout", pos())
				}
			case *ast.CallExpr:
				if id, ok := x.Fun.(*ast.Ident); ok && id.Name == "new" && len(x.Args) == 1 && isHTTPServer(x.Args[0]) {
					t.Errorf("%s: new(http.Server) carries no timeouts", pos())
				}
				if s, ok := x.Fun.(*ast.SelectorExpr); ok {
					if p, ok := s.X.(*ast.Ident); ok && p.Name == "http" {
						switch s.Sel.Name {
						case "ListenAndServe", "ListenAndServeTLS", "Serve", "ServeTLS":
							t.Errorf("%s: http.%s bypasses an http.Server literal; build a server with ReadHeaderTimeout", pos(), s.Sel.Name)
						}
					}
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if files == 0 || servers == 0 {
		t.Fatalf("scan found files=%d servers=%d; guard is not seeing the tree", files, servers)
	}
}
