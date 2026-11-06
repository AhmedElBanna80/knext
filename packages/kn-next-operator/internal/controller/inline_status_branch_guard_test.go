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
	"os"
	"strings"
	"testing"
)

// setStatusConditionName is the call this guard looks for (a const for goconst).
const setStatusConditionName = "SetStatusCondition"

const nextAppControllerFile = "nextapp_controller.go"

// dynamicKeyPart marks an event argument that is not a literal/identifier.
const dynamicKeyPart = "<dynamic>"

// statusBranchScan is what scanStatusBranches reports.
type statusBranchScan struct {
	offenders      []string
	inApply        int  // SetStatusCondition calls inside applyStatusVerdict
	reachesVerdict bool // the validation branch calls computeStatusVerdict
	sawValidation  bool // the validation branch exists in nextapp_controller.go
	reconcileEvent map[string]int
}

// sanctionedConditionWriters are the only functions that may call
// SetStatusCondition, keyed "file:func". Each is the single writer of ONE
// kind's verdict; a write anywhere else is an inline status branch.
var sanctionedConditionWriters = map[string]string{
	"nextapp_controller.go:applyStatusVerdict":          "the single writer of a NextApp verdict",
	"backendservice_controller.go:applyFunctionVerdict": "the single writer of a BackendService verdict (a different kind)",
	"platform_controller.go:Reconcile":                  "KnextPlatform status (a different kind) is a copy of its computed desired state",
}

// sanctionedReconcileEvents are the inline emitEvent calls that already sat in
// NextApp Reconcile before this ratchet, keyed "Reason|message format". Each is a
// hard-error path (the step's error is also returned, which drives the backoff and
// precedes the verdict), so it cannot move into the verdict without changing the
// observable events. A NEW inline event in Reconcile is not in this map and reds;
// the right home for a new one is computeStatusVerdict.
var sanctionedReconcileEvents = map[string]string{
	"ReasonReconcileFailed|Failed to reconcile ServiceAccount: %s":       "step error: returned, precedes the verdict",
	"ReasonReconcileFailed|Failed to reconcile the zone signing key: %s": "step error: returned, precedes the verdict",
	"ReasonReconcileFailed|Failed to reconcile Knative Service: %s":      "step error: returned, precedes the verdict",
	"ReasonReconcileFailed|Failed to reconcile NetworkPolicy: %s":        "step error: returned, precedes the verdict",
	"ReasonReconcileFailed|Failed to reconcile KafkaSource: %s":          "step error: returned, precedes the verdict",
	"ReasonReconciled|NextApp reconciled successfully (image %s)":        "success event after the verdict is applied; not a status roll-up",
}

// eventKey names an emitEvent call by its reason and message format literal.
func eventKey(call *ast.CallExpr) string {
	if len(call.Args) < 4 {
		return "<unparseable>"
	}
	reason := dynamicKeyPart
	switch r := call.Args[2].(type) {
	case *ast.Ident:
		reason = r.Name
	case *ast.SelectorExpr:
		reason = r.Sel.Name
	}
	msg := dynamicKeyPart
	ast.Inspect(call.Args[3], func(n ast.Node) bool {
		if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING && msg == dynamicKeyPart {
			msg = strings.Trim(lit.Value, "\"")
		}
		return true
	})
	return reason + "|" + msg
}

// findValidationBranch locates the body of the
// `if err := validation.ValidateNextAppSpec...(...); err != nil && ... { ... }`
// statement by its content, not by line number.
func findValidationBranch(f *ast.File) *ast.BlockStmt {
	var branch *ast.BlockStmt
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
			branch = ifStmt.Body
		}
		return true
	})
	return branch
}

// scanStatusBranches scans the given non-test sources (name -> content).
func scanStatusBranches(t *testing.T, files map[string]string) statusBranchScan {
	t.Helper()
	res := statusBranchScan{reconcileEvent: map[string]int{}}
	fset := token.NewFileSet()
	for file, src := range files {
		f, err := parser.ParseFile(fset, file, src, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}
		var validationBranch *ast.BlockStmt
		if file == nextAppControllerFile {
			validationBranch = findValidationBranch(f)
			res.sawValidation = validationBranch != nil
		}
		inValidation := func(p token.Pos) bool {
			return validationBranch != nil && p > validationBranch.Lbrace && p < validationBranch.Rbrace
		}
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
				isNextAppReconcile := file == nextAppControllerFile && fn.Name.Name == lcReconcile

				if name == setStatusConditionName {
					key := file + ":" + fn.Name.Name
					if _, ok := sanctionedConditionWriters[key]; !ok {
						res.offenders = append(res.offenders, fmt.Sprintf(
							"%s:%d — SetStatusCondition in %s() is an inline status branch", file, line, fn.Name.Name))
					} else if key == nextAppControllerFile+":applyStatusVerdict" {
						res.inApply++
					}
				}
				if !isNextAppReconcile {
					return true
				}
				if name == "emitEvent" || name == "Event" {
					k := eventKey(call)
					res.reconcileEvent[k]++
					if _, ok := sanctionedReconcileEvents[k]; !ok || inValidation(call.Pos()) {
						res.offenders = append(res.offenders, fmt.Sprintf(
							"%s:%d — inline %s %q in Reconcile; the outcome belongs in the verdict", file, line, name, k))
					}
				}
				if inValidation(call.Pos()) {
					switch name {
					case "computeStatusVerdict":
						res.reachesVerdict = true
					case setStatusConditionName:
						res.offenders = append(res.offenders, fmt.Sprintf(
							"%s:%d — %s in the spec-validation branch of Reconcile; the outcome belongs in the verdict",
							file, line, name))
					}
				}
				return true
			})
		}
	}
	return res
}

func readControllerSources(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	files := map[string]string{}
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		b, err := os.ReadFile(n)
		if err != nil {
			t.Fatalf("read %s: %v", n, err)
		}
		files[n] = string(b)
	}
	return files
}

// The hard rule (`.claude/rules/architecture.md`) is absolute: honest-status
// conditions/events/requeues go in computeStatusVerdict, never as branches in
// Reconcile. This SCANS rather than enumerating, over EVERY non-test .go file in
// the package:
//
//   - every SetStatusCondition call must sit in a sanctioned verdict writer
//     (sanctionedConditionWriters, with reasons) — a call in Reconcile or in a
//     helper in any file is a new inline branch;
//   - every emitEvent in NextApp Reconcile must be in the sanctioned list
//     (sanctionedReconcileEvents, with reasons) — a new inline event reds, and the
//     allowlist must be exact (no stale entries);
//   - the spec-validation branch must reach the verdict and write nothing itself.
//
// Both halves are asserted: the negative (no stray writes) and the positive (the
// verdict path is wired, the validation branch exists, every allowlist entry is
// still live), so deleting the subject cannot leave the guard green.
func TestNoInlineStatusBranchesInReconcile(t *testing.T) {
	res := scanStatusBranches(t, readControllerSources(t))

	for _, o := range res.offenders {
		t.Errorf("%s. Per .claude/rules/architecture.md and ADR-0040 it belongs in "+
			"computeStatusVerdict (status_verdict.go).", o)
	}
	if !res.sawValidation {
		t.Fatalf("could not find the spec-validation branch in %s — this guard is only "+
			"meaningful while that branch exists; if it moved, move the guard with it", nextAppControllerFile)
	}
	if res.inApply == 0 {
		t.Errorf("no SetStatusCondition inside applyStatusVerdict — the verdict path is " +
			"supposed to be the only writer of conditions, so the scan is proving nothing")
	}
	if !res.reachesVerdict {
		t.Errorf("the spec-validation branch no longer calls computeStatusVerdict — the " +
			"invalid-spec outcome must come from the verdict, not be dropped")
	}
	for k := range sanctionedReconcileEvents {
		if res.reconcileEvent[k] != 1 {
			t.Errorf("sanctioned inline event %q occurs %d times in Reconcile, want exactly 1 — "+
				"remove or fix the stale allowlist entry", k, res.reconcileEvent[k])
		}
	}
}

// The scan itself must bite: prove it on synthetic sources, so a regression in
// the scan (not only in the controller) turns a test red.
func TestScanStatusBranches_Bites(t *testing.T) {
	const base = `package controller
func (r *R) Reconcile() {
	if err := validation.ValidateNextAppSpec(x); err != nil {
		computeStatusVerdict()
	}
%s}
func (r *R) applyStatusVerdict() { apimeta.SetStatusCondition(a, b) }
`
	clean := fmt.Sprintf(base, "")

	t.Run("clean", func(t *testing.T) {
		res := scanStatusBranches(t, map[string]string{nextAppControllerFile: clean})
		if len(res.offenders) != 0 || !res.reachesVerdict || !res.sawValidation || res.inApply != 1 {
			t.Fatalf("clean source flagged: %+v", res)
		}
	})
	t.Run("new inline event in Reconcile", func(t *testing.T) {
		src := fmt.Sprintf(base, "\tr.emitEvent(a, w, ReasonReconcileFailed, fmt.Sprintf(\"brand new %s\", e))\n")
		res := scanStatusBranches(t, map[string]string{nextAppControllerFile: src})
		if len(res.offenders) != 1 || !strings.Contains(res.offenders[0], "brand new") {
			t.Fatalf("offenders = %v, want exactly the new event", res.offenders)
		}
	})
	t.Run("sanctioned event moved into the validation branch", func(t *testing.T) {
		src := strings.Replace(clean, "computeStatusVerdict()",
			"computeStatusVerdict()\n\t\tr.emitEvent(a, w, ReasonReconciled, fmt.Sprintf(\"NextApp reconciled successfully (image %s)\", i))", 1)
		res := scanStatusBranches(t, map[string]string{nextAppControllerFile: src})
		if len(res.offenders) != 1 {
			t.Fatalf("offenders = %v, want the event in the validation branch", res.offenders)
		}
	})
	t.Run("condition write in a helper in another file", func(t *testing.T) {
		other := "package controller\nfunc helper() { apimeta.SetStatusCondition(a, b) }\n"
		res := scanStatusBranches(t, map[string]string{nextAppControllerFile: clean, "some_helper.go": other})
		if len(res.offenders) != 1 || !strings.Contains(res.offenders[0], "some_helper.go") {
			t.Fatalf("offenders = %v, want the helper write", res.offenders)
		}
	})
	t.Run("condition write in Reconcile", func(t *testing.T) {
		src := fmt.Sprintf(base, "\tapimeta.SetStatusCondition(a, b)\n")
		res := scanStatusBranches(t, map[string]string{nextAppControllerFile: src})
		if len(res.offenders) != 1 {
			t.Fatalf("offenders = %v, want the Reconcile write", res.offenders)
		}
	})
}
