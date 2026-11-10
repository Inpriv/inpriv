// Keep only this list header, inside the encrypted message body, never metadata.
export function listUnsubscribeHeader(headers) {
  return headerValue(headers, "list-unsubscribe");
}

// `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is what tells the client
// the sender accepts a server-side POST instead of a browser visit. Same rule:
// it travels inside the encrypted payload, never as metadata.
export function listUnsubscribePostHeader(headers) {
  return headerValue(headers, "list-unsubscribe-post");
}

function headerValue(headers, wanted) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    if (typeof value !== "string" || value.length > 8192 || !value.trim()) return null;
    return value;
  }
  return null;
}
