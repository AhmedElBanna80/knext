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
	"context"
	"fmt"
	"sort"
	"strings"
)

// A user is a shared credential when it can reach another app's data or take the
// server over, whether or not it holds a key pattern: PSYNC and SYNC stream the
// whole dataset, MONITOR streams every command, FLUSHALL and SWAPDB destroy every
// app's cache, ACL SETUSER grants itself anything, CONFIG GET, SLOWLOG, SHUTDOWN
// and REPLICAOF are administration.
//
// What counts as dangerous is the SERVER's answer, not a list written here: the
// members of the @admin and @dangerous categories, read with ACL CAT. A hand-kept
// list misses commands (it missed FLUSHALL, FLUSHDB, SWAPDB, FAILOVER, SHUTDOWN,
// CONFIG GET, SLOWLOG and ACL LOAD/DELUSER), and the next Redis adds more.

// commandCatalog answers "can these command rules run anything dangerous?".
type commandCatalog struct {
	fetch     func(category string) ([]string, error)
	cats      map[string]map[string]bool
	dangerous []string // sorted, deterministic: the first match is reported
}

// newCommandCatalogFrom builds a catalog over a category lookup. It reads @admin
// and @dangerous now and fails if either is unreadable or empty: an empty answer
// is as unusable as a refusal, and neither may be read as "nothing is dangerous".
// Any other category is read the first time a rule mentions it.
func newCommandCatalogFrom(fetch func(category string) ([]string, error)) (*commandCatalog, error) {
	c := &commandCatalog{fetch: fetch, cats: map[string]map[string]bool{}}
	set := map[string]bool{}
	for _, cat := range []string{"admin", "dangerous"} {
		members, err := c.members(cat)
		if err != nil {
			return nil, err
		}
		if len(members) == 0 {
			return nil, fmt.Errorf("ACL CAT %s returned no commands", cat)
		}
		for name := range members {
			set[name] = true
		}
	}
	for name := range set {
		c.dangerous = append(c.dangerous, name)
	}
	sort.Strings(c.dangerous)
	return c, nil
}

// newCommandCatalog reads the categories from the endpoint (the provisioner needs
// +acl|cat for it).
func newCommandCatalog(ctx context.Context, prov RedisProvisioner) (*commandCatalog, error) {
	return newCommandCatalogFrom(func(category string) ([]string, error) {
		names, err := prov.CommandCategory(ctx, category)
		if err != nil {
			return nil, fmt.Errorf("ACL CAT %s: %w", category, err)
		}
		return names, nil
	})
}

// members is a category's commands, read once.
func (c *commandCatalog) members(category string) (map[string]bool, error) {
	if m, ok := c.cats[category]; ok {
		return m, nil
	}
	names, err := c.fetch(category)
	if err != nil {
		return nil, err
	}
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[strings.ToLower(n)] = true
	}
	c.cats[category] = m
	return m, nil
}

// commandParent is "acl" for "acl|setuser" and the command itself when it has no
// subcommand.
func commandParent(cmd string) string {
	parent, _, _ := strings.Cut(cmd, "|")
	return parent
}

// ruleCovers reports whether a command rule (the text after + or -) names the
// command, or its parent as a whole. For allowing (+), a rule on a subcommand also
// reaches a command that has no subcommands of its own and shares the parent
// ("+debug|sleep" allows DEBUG): the check errs toward live.
func ruleCovers(rule, cmd string, allowing bool) bool {
	if rule == cmd || rule == commandParent(cmd) {
		return true
	}
	return allowing && !strings.Contains(cmd, "|") && commandParent(rule) == cmd
}

// firstAllowed reports the first dangerous command the rules end up allowing.
// Redis applies the rules left to right, so for each command the LAST rule that
// mentions it (by name, by parent, or through a category that holds it) decides:
// "+@all -@dangerous" allows none, "+@all -@dangerous +psync" allows psync.
func (c *commandCatalog) firstAllowed(rules string) (string, bool, error) {
	tokens := strings.Fields(strings.ToLower(rules))
	for _, cmd := range c.dangerous {
		allowed := false
		for _, tok := range tokens {
			switch tok {
			case "allcommands", "+@all":
				allowed = true
				continue
			case "nocommands", "-@all":
				allowed = false
				continue
			}
			if len(tok) < 2 || (tok[0] != '+' && tok[0] != '-') {
				continue // not a command rule
			}
			adding, body := tok[0] == '+', tok[1:]
			if category, isCategory := strings.CutPrefix(body, "@"); isCategory {
				members, err := c.members(category)
				if err != nil {
					return "", false, err
				}
				if members[cmd] {
					allowed = adding
				}
				continue
			}
			if ruleCovers(body, cmd, adding) {
				allowed = adding
			}
		}
		if allowed {
			return cmd, true, nil
		}
	}
	return "", false, nil
}
