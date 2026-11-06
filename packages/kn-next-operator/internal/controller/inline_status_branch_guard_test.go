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
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// setStatusConditionName is the call this guard looks for (a const for goconst).
const setStatusConditionName = "SetStatusCondition"

// The hard rule (`.claude/rules/architecture.md`) is absolute: honest-status
// conditions/events/requeues go in computeStatusVerdict, never as branches in
// Reconcile. The one inline branch that predated the rule — the spec-validation
// gate (#85) — has moved into the verdict path (withInvalidSpec /
// invalidSpecVerdict in status_verdict.go; ADR-0040 amendment), so the count of
// inline status branches in Reconcile is now ZERO.
//
// This SCANS rather than enumerating, over nextapp_controller.go:
//
//   - every SetStatusCondition call must sit in applyStatusVerdict, the single
//     writer of a verdict — a call in Reconcile or in any helper is a new inline
//     branch;
//   - the spec-validation branch in Reconcile must reach the verdict
//     (computeStatusVerdict) and must itself write no condition and emit no event.
//
// Both halves are asserted: the negative (no stray writes) and the positive (the
// verdict path is really wired and the validation branch still exists), so
// deleting the branch or the scan's subject cannot leave the guard green.
func TestNoInlineStatusBranchesInReconcile(t *testing.T) {
	const file = "nextapp_controller.go"

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}

	// The spec-validation branch: the body of the
	// `if err := validation.ValidateNextAppSpec...(...); err != nil && ... { ... }`
	// statement. Located by its content, not by line number.
	var validationBranch *ast.BlockStmt
	ast.Inspect(f, func(n ast.Node) bool {
		ifStmt, ok := n.(*ast.IfStmt)
		if !ok || ifStmt.Init == nil {
			return true
		}
		found := false
		ast.Inspect(ifStmt.Init, func(m ast.Node) bool {
			if sel, ok := m.(*ast.SelectorExpr); ok && strings.HasPrefix(sel.Sel.Name, "ValidateNextAppSpec") {
				found = true
			}
			return true
		})
		if found {
			validationBranch = ifStmt.Body
		}
		return true
	})
	if validationBranch == nil {
		t.Fatalf("could not find the spec-validation branch in %s — this guard is only "+
			"meaningful while that branch exists; if it moved, move the guard with it", file)
	}
	inValidation := func(p token.Pos) bool { return p > validationBranch.Lbrace && p < validationBranch.Rbrace }

	inApply := 0
	var offenders []string
	reachesVerdict := false
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			name := ""
			switch fun := call.Fun.(type) {
			case *ast.SelectorExpr:
				name = fun.Sel.Name
			case *ast.Ident:
				name = fun.Name
			}
			line := fset.Position(call.Pos()).Line

			if name == setStatusConditionName {
				if fn.Name.Name == "applyStatusVerdict" {
					inApply++
				} else {
					offenders = append(offenders, fmt.Sprintf(
						"%s:%d — SetStatusCondition in %s() is an inline status branch", file, line, fn.Name.Name))
				}
			}
			if fn.Name.Name == lcReconcile && inValidation(call.Pos()) {
				switch name {
				case "computeStatusVerdict":
					reachesVerdict = true
				case setStatusConditionName, "emitEvent", "Event":
					offenders = append(offenders, fmt.Sprintf(
						"%s:%d — %s in the spec-validation branch of Reconcile; the outcome belongs in the verdict",
						file, line, name))
				}
			}
			return true
		})
	}

	for _, o := range offenders {
		t.Errorf("%s. Per .claude/rules/architecture.md and ADR-0040 it belongs in "+
			"computeStatusVerdict (status_verdict.go).", o)
	}
	if inApply == 0 {
		t.Errorf("no SetStatusCondition inside applyStatusVerdict — the verdict path is " +
			"supposed to be the only writer of conditions, so the scan is proving nothing")
	}
	if !reachesVerdict {
		t.Errorf("the spec-validation branch no longer calls computeStatusVerdict — the " +
			"invalid-spec outcome must come from the verdict, not be dropped")
	}
}
