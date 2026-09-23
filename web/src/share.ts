import type { Build } from '@sim';

/**
 * A build in a link.
 *
 * The whole build travels in the URL fragment, so a share is a link and
 * nothing more: no account, no server, nothing stored anywhere. A fragment
 * rather than a query string because a fragment is never sent to the host
 * the page is served from -- what someone is planning is their business.
 *
 * The payload is the build as JSON, deflated and base64url-encoded, behind
 * a one-character tag saying which of the two it is. Deflate is what makes
 * it a link rather than a wall of text: the same handful of slot keys and
 * field names repeat all through a build, which is exactly what it is good
 * at, and a full build comes out around a fifth of its JSON.
 */

export const SHARE_PARAM = 'b';

const DEFLATED = 'z';
const PLAIN = 'u';

/** Empty slots left out: a slot with nothing in it is the default anyway. */
function trim(build: Build): Build {
  const slots: Build['slots'] = {};
  for (const [key, state] of Object.entries(build.slots)) {
    if (state?.itemId) slots[key] = state;
  }
  const out: Build = { ...build, slots };
  // Same reasoning for the optional fields: an empty list is not worth the
  // characters, and its absence restores as the same thing.
  if (!out.goals?.length) delete out.goals;
  if (!out.locked?.length) delete out.locked;
  // Guards are the exception: an empty list is not the same as none, because
  // absent means "the defaults" and empty means "I took them off".
  if (!out.guards) delete out.guards;
  if (!out.manual || Object.keys(out.manual).length === 0) delete out.manual;
  return out;
}

export async function encodeBuild(build: Build): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(trim(build)));
  const deflated = await squeeze(json, 'deflate-raw');
  return deflated
    ? DEFLATED + base64url(deflated)
    : PLAIN + base64url(json);
}

/**
 * The build in a shared payload, or null if it is not one.
 *
 * Returns the parsed object rather than a `Build`: it came from outside the
 * app and has not been checked against the dataset yet, which is
 * `reconcile`'s job.
 */
export async function decodeBuild(payload: string): Promise<Build | null> {
  try {
    const tag = payload[0];
    const bytes = unbase64url(payload.slice(1));
    const json = tag === DEFLATED
      ? await expand(bytes, 'deflate-raw')
      : tag === PLAIN ? bytes : null;
    if (!json) return null;
    const parsed = JSON.parse(new TextDecoder().decode(json));
    // A build is an object with slots. Everything past that shape is
    // reconcile's business, not this function's.
    return parsed && typeof parsed === 'object' && parsed.slots ? parsed as Build : null;
  } catch {
    // A truncated, hand-edited or simply unrelated fragment. Not an error
    // worth showing: there is nothing the reader could do about it.
    return null;
  }
}

/** The share link for a build, against the page it is shared from. */
export async function shareUrl(build: Build): Promise<string> {
  const base = location.href.split('#')[0];
  return `${base}#${SHARE_PARAM}=${await encodeBuild(build)}`;
}

/** The payload in a URL's fragment, if it carries one. */
export function payloadIn(href: string): string | null {
  const hash = href.split('#')[1];
  if (!hash) return null;
  const match = new URLSearchParams(hash).get(SHARE_PARAM);
  return match || null;
}

// ---- bytes ---------------------------------------------------------------

async function squeeze(bytes: Uint8Array, format: string): Promise<Uint8Array | null> {
  // Absent in older Safari, and a link that is merely long still works.
  if (typeof CompressionStream === 'undefined') return null;
  return drain(new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new CompressionStream(format as CompressionFormat)));
}

async function expand(bytes: Uint8Array, format: string): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  return drain(new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream(format as CompressionFormat)));
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * base64, in the alphabet a URL can carry unescaped.
 *
 * `+` and `/` would be percent-encoded by anything that touches the link,
 * and the `=` padding is not needed to decode a string whose length is
 * known -- so all three go.
 */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: spreading a whole build into String.fromCharCode at once can
  // overflow the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
