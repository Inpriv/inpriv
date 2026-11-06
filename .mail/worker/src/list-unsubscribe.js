// Keep only this list header, inside the encrypted message body, never metadata.
export function listUnsubscribeHeader(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "list-unsubscribe") continue;
    if (typeof value !== "string" || value.length > 8192 || !value.trim()) return null;
    return value;
  }
  return null;
}
