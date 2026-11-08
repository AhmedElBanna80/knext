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
	"go/ast"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/tools/go/packages"
)

// loadNameFixture scans testdata/namescan with the same per-function scanner
// the inventory uses and returns the recorded name helpers per function.
func loadNameFixture(t *testing.T) map[string][]string {
	t.Helper()
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes |
			packages.NeedTypesInfo | packages.NeedImports,
	}
	pkgs, err := packages.Load(cfg, "./testdata/namescan")
	if err != nil || len(pkgs) != 1 || len(pkgs[0].Errors) > 0 {
		t.Fatalf("load the name fixture: %v %v", err, pkgs)
	}
	scan := &operatorScan{
		funcWrites: map[string]bool{}, typeRefs: map[string]bool{},
		nameFuncs: map[string][]string{}, nonConstKind: map[string]string{},
		secretTypes: map[string][]string{},
	}
	for _, file := range pkgs[0].Syntax {
		for _, decl := range file.Decls {
			if fd, ok := decl.(*ast.FuncDecl); ok && fd.Body != nil {
				scan.scanFunc(pkgs[0], fd)
			}
		}
	}
	out := map[string][]string{}
	for fn, helpers := range scan.nameFuncs {
		out[strings.TrimPrefix(fn, fixturePkgPath+".")] = helpers
	}
	return out
}

const fixturePkgPath = operatorModulePath + "/internal/controller/testdata/namescan"

// TestInventoryScannerReadsBothNameShapes: the object's name is found in the
// classic ObjectMeta literal and in the promoted-field form; a nameless object
// records nothing in either shape (so the registry test reddens); and a Name on
// a type that is not an object is not mistaken for one.
func TestInventoryScannerReadsBothNameShapes(t *testing.T) {
	got := loadNameFixture(t)
	want := map[string][]string{
		"classicNamed":    {"nameHelper"},
		"flatNamed":       {"nameHelper"},
		"flatLiteralName": {"(not a helper call)"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("recorded names = %v, want %v (nameless shapes must record nothing; the decoy must not count)", got, want)
	}
}
