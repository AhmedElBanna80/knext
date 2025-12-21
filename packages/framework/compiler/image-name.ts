/**
 * Parses a Docker image name and splits it into base and tag components.
 * Handles registries with ports correctly (e.g., localhost:5000/image:tag).
 *
 * @param baseImageName - Full image name, optionally with a tag (e.g., "repo/image:v1" or "localhost:5000/image:v1")
 * @returns An object with `base` (image name without tag) and `tag` (tag string or empty)
 */
export function parseImageName(baseImageName: string): { base: string; tag: string } {
  const lastSlash = baseImageName.lastIndexOf('/');
  const lastColon = baseImageName.lastIndexOf(':');
  const hasTag = lastColon > lastSlash;

  const base = hasTag ? baseImageName.slice(0, lastColon) : baseImageName;
  const tag = hasTag ? baseImageName.slice(lastColon + 1) : '';

  return { base, tag };
}

/**
 * Constructs a new Docker image name by appending a group suffix.
 *
 * @param baseImageName - Base image name (e.g., "repo/image:v1")
 * @param groupName - Group/route name to append
 * @returns Constructed image name (e.g., "repo/image-groupName:v1")
 */
export function buildGroupImageName(baseImageName: string, groupName: string): string {
  const { base, tag } = parseImageName(baseImageName);
  return tag ? `${base}-${groupName}:${tag}` : `${base}-${groupName}`;
}
