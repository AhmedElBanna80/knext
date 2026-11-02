---
"@getknext/core": patch
---

A self-contained vinext build now carries the app's own data files inside the executable, so reads of them work from a directory that holds only the binary. That covers the files listed in `outputFileTracingIncludes` and the project files the server code names by literal path, such as `join(process.cwd(), 'content/post.md')` or `new URL('../data.json', import.meta.url)`. They are read with `fs` or `fs/promises` by relative, working-directory or build-machine absolute path; any file that was not embedded is still a real `ENOENT`. The build now fails instead of dropping an include that cannot be embedded: one that matches nothing, resolves outside the app root, looks like a secret, is a native addon, or belongs to a package the build traced into `.output/server/node_modules` (the executable cannot resolve a package from inside itself).
