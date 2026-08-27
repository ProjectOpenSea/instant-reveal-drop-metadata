/**
 * Error text reaches the public: `/status` publishes the last failure, and a
 * request that throws answers with its message. Both are useful, and neither
 * is worth a leaked credential.
 *
 * What ends up in those messages is not ours. An RPC endpoint writes its own
 * error strings, `fetch` writes its own, and a self-hosted operator can put an
 * API key in a URL, a bearer token in a header, or both. So rather than trust
 * every producer to stay clean, everything is scrubbed at the one point where
 * it becomes a string a stranger can read.
 */

/** Any URL. The host is fine to publish, the path and query are not. */
const URL_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s"']+)/gi;

/** A long unbroken run of key-ish characters, which is what an API key looks like. */
const KEYLIKE_RE = /\b[A-Za-z0-9_-]{32,}\b/g;

const MAX_LENGTH = 300;

/**
 * Strip credentials out of a message, and cap its length so a remote endpoint
 * cannot use our own error reporting as a place to put whatever it likes.
 */
export function redact(message: string): string {
  const scrubbed = message
    .replace(URL_RE, (match) => {
      try {
        // Keep the host, which is the part that helps someone debug.
        return `${new URL(match).host}/...`;
      } catch {
        return "(url)";
      }
    })
    .replace(KEYLIKE_RE, "(redacted)");

  return scrubbed.length > MAX_LENGTH ? `${scrubbed.slice(0, MAX_LENGTH)}...` : scrubbed;
}

/** `redact`, for something that may not be an Error. */
export function redactError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}
