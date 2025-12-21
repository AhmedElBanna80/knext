/**
 * Patches a Next.js client-reference-manifest.js file to replace /_next/static/ with static/.
 * The manifest is a JavaScript file containing a module.exports = {...} assignment.
 * This function parses the JSON portion, recursively updates string values, and returns the patched content.
 *
 * @param content - The raw content of the manifest.js file
 * @returns Patched content, or null if the file format is not recognized
 */
export function patchManifestJs(content: string): string | null {
  const assignmentIndex = content.indexOf('=');
  const jsonStart = assignmentIndex !== -1 ? content.indexOf('{', assignmentIndex) : -1;
  const jsonEnd = jsonStart !== -1 ? content.lastIndexOf('}') : -1;

  if (assignmentIndex === -1 || jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    return null;
  }

  const updateManifestValues = (value: any): any => {
    const staticPrefix = '/_next/static/';
    if (typeof value === 'string') {
      return value.includes(staticPrefix) ? value.replace(staticPrefix, 'static/') : value;
    }
    if (Array.isArray(value)) return value.map(updateManifestValues);
    if (value && typeof value === 'object') {
      const result: any = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = updateManifestValues(v);
      }
      return result;
    }
    return value;
  };

  const jsonText = content.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(jsonText);
    const updated = updateManifestValues(parsed);
    const updatedJsonText = JSON.stringify(updated);
    return content.slice(0, jsonStart) + updatedJsonText + content.slice(jsonEnd + 1);
  } catch {
    return null;
  }
}
