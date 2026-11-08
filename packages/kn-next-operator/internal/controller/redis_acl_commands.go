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

import "strings"

// Commands that make a user a shared credential even when it holds no key
// pattern at all. A user is judged by what it can run, not only by what it can
// address:
//
//   - psync / sync stream the whole dataset to the caller, every app's keys;
//   - monitor streams every command every client runs, arguments included;
//   - acl|setuser lets the user grant itself anything;
//   - config|set, module load/unload and debug are server administration.
//
// Every one of them belongs to the @admin, @dangerous and @slow categories.
const debugCommand = "debug" // any DEBUG subcommand counts, see ruleCovers

var dangerousCommands = []string{
	"psync", "sync", "monitor", debugCommand,
	"module|load", "module|loadex", "module|unload",
	"acl|setuser", "config|set",
}

// dangerousCategories are the command categories that contain every command in
// dangerousCommands: allowing one allows them all, denying one denies them all.
var dangerousCategories = map[string]bool{"all": true, "admin": true, "dangerous": true, "slow": true}

// commandParent is "acl" for "acl|setuser" and the command itself when it has no
// subcommand.
func commandParent(cmd string) string {
	parent, _, _ := strings.Cut(cmd, "|")
	return parent
}

// ruleCovers reports whether a command rule (the text after + or -) names the
// dangerous command, or its parent command as a whole. For allowing (+) a rule on
// a subcommand of debug counts too: any debug subcommand is administration, and
// the check errs toward live.
func ruleCovers(rule, dangerous string, allowing bool) bool {
	if rule == dangerous || rule == commandParent(dangerous) {
		return true
	}
	return allowing && dangerous == debugCommand && commandParent(rule) == debugCommand
}

// commandRulesAllowDangerous reports the first dangerous command a user's command
// rules end up allowing. Redis applies the rules left to right, so for each
// dangerous command the LAST rule that mentions it (or a category that holds it)
// decides: "+@all -@dangerous" allows none, "+@all -@dangerous +psync" allows
// psync. Rules are the text ACL GETUSER prints for "commands".
func commandRulesAllowDangerous(rules string) (string, bool) {
	tokens := strings.Fields(strings.ToLower(rules))
	for _, cmd := range dangerousCommands {
		allowed := false
		for _, tok := range tokens {
			switch tok {
			case "allcommands":
				allowed = true
				continue
			case "nocommands":
				allowed = false
				continue
			}
			if len(tok) < 2 || (tok[0] != '+' && tok[0] != '-') {
				continue // not a command rule
			}
			adding, body := tok[0] == '+', tok[1:]
			if category, isCategory := strings.CutPrefix(body, "@"); isCategory {
				if dangerousCategories[category] {
					allowed = adding
				}
				continue
			}
			if ruleCovers(body, cmd, adding) {
				allowed = adding
			}
		}
		if allowed {
			return cmd, true
		}
	}
	return "", false
}
