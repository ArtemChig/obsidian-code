// URL helpers shared by WebFetch and the permission engine, so a domain rule is checked against exactly the host the
// tool will contact (scheme-less input, trailing dots, IDN/punycode, brackets).

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Lower-case, punycode (via URL), no brackets, no trailing dots. '' when it is not a valid host. */
export function canonicalHost(host: string): string {
  let h = String(host ?? '').trim().toLowerCase();
  if (!h) return '';
  if (!h.startsWith('[') && !isIP(h)) {
    try {
      h = new URL(`https://${h}/`).hostname;
    } catch {
      return '';
    }
  }
  return h.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** Hosts reached over plain http without an upgrade and exempt from the DNS-rebinding check (the user saw them). */
export function isLocalHost(host: string): boolean {
  const h = canonicalHost(host);
  if (!h) return false;
  if (isIP(h)) return isPrivateAddress(h);
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.test') || !h.includes('.');
}

/** Loopback, RFC1918, CGNAT, link-local (incl. cloud metadata), unique-local, unspecified and IPv4-mapped forms of those. */
export function isPrivateAddress(ip: string): boolean {
  const a = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const v = isIP(a);
  if (v === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  if (v === 6) {
    if (a === '::' || a === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true; // hex-form mapped v4: be conservative
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a);
  }
  return false;
}

export function normalizeUrl(raw: string): { url: URL; original: URL } | { error: string } {
  let s = String(raw ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let original: URL;
  try {
    original = new URL(s);
  } catch {
    return { error: `Invalid URL: ${raw}` };
  }
  if (original.protocol !== 'http:' && original.protocol !== 'https:') return { error: `Unsupported URL scheme "${original.protocol}" (only http/https).` };
  if (!canonicalHost(original.hostname)) return { error: `Invalid URL: ${raw}` };
  const url = new URL(original.href);
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) url.protocol = 'https:';
  return { url, original };
}

/** The canonical host WebFetch would contact for this input, or null when the input is not a fetchable URL. */
export function fetchHost(raw: string): string | null {
  const n = normalizeUrl(raw);
  if ('error' in n) return null;
  return canonicalHost(n.url.hostname) || null;
}

export type LookupAll = (host: string) => Promise<{ address: string }[]>;

const defaultLookup: LookupAll = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * DNS-rebinding guard: a public-looking host name must not resolve to a private/loopback address. Hosts the user
 * named explicitly as local (localhost, *.local, private IP literals) are allowed. Lookup failures are not decided
 * here (the fetch reports them). Returns an error message or null.
 */
export async function privateResolutionError(host: string, lookup: LookupAll = defaultLookup): Promise<string | null> {
  const h = canonicalHost(host);
  if (!h || isLocalHost(h) || isIP(h)) return null;
  let addrs: { address: string }[];
  try {
    addrs = await lookup(h);
  } catch {
    return null;
  }
  const bad = addrs.find((x) => isPrivateAddress(x.address));
  return bad
    ? `Refused: ${h} resolves to the private/loopback address ${bad.address}. Fetching local-network services through a public host name is blocked; use the address itself (e.g. http://${bad.address}/) if that is really intended.`
    : null;
}
