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
	"strings"
)

// A copy of what `ACL CAT <category>` printed on the Redis 7.4 image the CI lane
// and the kind drill use (admin and dangerous complete; write, read, keyspace,
// connection, scripting and slow trimmed to what the tests mention). The names
// are exactly the server's: subcommands as "config|set". The kind drill asks the
// real server, which is what keeps this copy honest.
var redisCategoriesFixture = map[string][]string{
	"admin": strings.Fields(`config|rewrite config|get config|resetstat config|set sync slowlog|reset
		slowlog|get slowlog|len bgsave replconf monitor role latency|graph latency|history latency|latest
		latency|histogram latency|doctor latency|reset save debug pfselftest bgrewriteaof module|load
		module|loadex module|list module|unload psync replicaof cluster|delslots cluster|bumpepoch
		cluster|set-config-epoch cluster|failover cluster|replicate cluster|forget cluster|flushslots
		cluster|addslotsrange cluster|delslotsrange cluster|replicas cluster|setslot cluster|addslots
		cluster|meet cluster|count-failure-reports cluster|reset cluster|slaves cluster|saveconfig
		failover slaveof acl|log acl|getuser acl|load acl|deluser acl|list acl|setuser acl|save acl|users
		acl|dryrun lastsave shutdown client|pause client|no-evict client|list client|kill client|unpause
		client|unblock pfdebug`),
	"dangerous": strings.Fields(`config|rewrite config|get config|resetstat config|set sync keys
		slowlog|reset slowlog|get slowlog|len bgsave replconf flushall monitor role latency|graph
		latency|history latency|latest latency|histogram latency|doctor latency|reset save debug restore
		sort_ro sort pfselftest bgrewriteaof module|load module|loadex module|list module|unload psync
		migrate info restore-asking replicaof cluster|delslots cluster|bumpepoch cluster|set-config-epoch
		cluster|failover cluster|replicate cluster|forget cluster|flushslots cluster|addslotsrange
		cluster|delslotsrange cluster|replicas cluster|setslot cluster|addslots cluster|meet
		cluster|count-failure-reports cluster|reset cluster|slaves cluster|saveconfig failover slaveof
		swapdb acl|log acl|getuser acl|load acl|deluser acl|list acl|setuser acl|save acl|users acl|dryrun
		lastsave shutdown client|pause client|no-evict client|list client|kill client|unpause
		client|unblock flushdb pfdebug`),
	"write": strings.Fields(`flushdb flushall swapdb migrate restore restore-asking sort set del lpush
		hset expire rename mset append incr decr copy move zadd xadd function|load pfdebug`),
	"read":     strings.Fields(`get keys sort_ro scan exists ttl type mget strlen hget lrange smembers zrange dbsize randomkey`),
	"keyspace": strings.Fields(`flushdb flushall swapdb migrate restore keys scan del exists rename expire ttl type dbsize randomkey copy move`),
	"connection": strings.Fields(`ping auth select echo reset hello quit client|setinfo client|setname client|id
		client|info client|getname client|kill client|pause client|unpause client|list client|no-evict`),
	"scripting": strings.Fields(`eval evalsha eval_ro evalsha_ro fcall fcall_ro script|load script|exists script|flush script|kill script|debug`),
	"fast":      strings.Fields(`get set ping swapdb exists ttl time hget`),
	// slow is everything in admin and dangerous except swapdb (which is fast), plus
	// the scripting commands and a few keyspace ones.
	"slow": append(
		strings.Fields(`eval evalsha scan sort_ro mget`),
		append(
			strings.Fields(`config|rewrite config|get config|resetstat config|set sync keys slowlog|reset
				slowlog|get slowlog|len bgsave replconf flushall flushdb monitor role save debug restore sort
				pfselftest bgrewriteaof module|load module|loadex module|list module|unload psync migrate info
				replicaof failover slaveof acl|log acl|getuser acl|load acl|deluser acl|list acl|setuser acl|save
				acl|users acl|dryrun lastsave shutdown client|pause client|no-evict client|list client|kill
				client|unpause client|unblock pfdebug restore-asking`), "latency|doctor")...,
	),
}

// fixtureCategory is the lookup the tests give a catalog and the fake provisioner.
func fixtureCategory(category string) ([]string, error) {
	names, ok := redisCategoriesFixture[category]
	if !ok {
		return nil, nil // an unknown category is empty, as ACL CAT of one would be an error; tests do not ask
	}
	return append([]string(nil), names...), nil
}

// failingCategory is a lookup whose ACL CAT is refused.
func failingCategory(string) ([]string, error) {
	return nil, fmt.Errorf("NOPERM this user has no permissions to run the 'acl|cat' command")
}
