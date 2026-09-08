import dns from 'node:dns';
import net from 'node:net';

/**
 * SSRF protection.
 *
 * Blocked ranges (documented):
 *   IPv4:
 *     10.0.0.0/8        private
 *     172.16.0.0/12     private
 *     192.168.0.0/16    private
 *     127.0.0.0/8       loopback
 *     169.254.0.0/16    link-local
 *     0.0.0.0/8         "this network"
 *     100.64.0.0/10     carrier-grade NAT
 *   IPv6:
 *     ::1               loopback
 *     fc00::/7          unique local address (ULA)
 *     fe80::/10         link-local
 *     ::ffff:0:0/96     IPv4-mapped (decoded to IPv4 and checked against the IPv4 ranges)
 *
 * Hostnames `localhost`, `*.localhost`, `*.local` and `*.internal` are refused outright.
 *
 * The flow per request hop is:
 *   1. validateUrl()   – protocol + hostname-level checks (literal IPs are checked here)
 *   2. resolveAndCheck() – DNS lookup; if ANY resolved address is private/blocked, refuse.
 * Step 2 is repeated on every redirect hop (see fetch/client.js). Note: this is a
 * check-at-request-time guard; a fully DNS-rebinding-hardened production deployment
 * should pin the validated IP and connect to it directly (out of MVP scope).
 */

const ipv4ToInt = (ip) => {
  const [a, b, c, d] = ip.split('.').map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
};

const BLOCKED_IPV4 = [
  [ipv4ToInt('0.0.0.0'), ipv4ToInt('0.255.255.255')],
  [ipv4ToInt('10.0.0.0'), ipv4ToInt('10.255.255.255')],
  [ipv4ToInt('100.64.0.0'), ipv4ToInt('100.127.255.255')],
  [ipv4ToInt('127.0.0.0'), ipv4ToInt('127.255.255.255')],
  [ipv4ToInt('169.254.0.0'), ipv4ToInt('169.254.255.255')],
  [ipv4ToInt('172.16.0.0'), ipv4ToInt('172.31.255.255')],
  [ipv4ToInt('192.168.0.0'), ipv4ToInt('192.168.255.255')],
];

const isBlockedIpv4Int = (n) => BLOCKED_IPV4.some(([lo, hi]) => n >= lo && n <= hi);

const isBlockedIpv4 = (ip) => {
  if (net.isIP(ip) !== 4) return false;
  return isBlockedIpv4Int(ipv4ToInt(ip));
};

const ipv6ToBigInt = (ip) => {
  const s = ip.toLowerCase();
  const parts = s.split('::');
  const headParts = parts[0] ? parts[0].split(':') : [];
  const tailParts = parts[1] !== undefined && parts[1] ? parts[1].split(':') : [];
  // A dotted-quad tail (::ffff:127.0.0.1) occupies 32 bits = 2 hex groups.
  const weight = (p) => (p.includes('.') ? 2 : 1);
  const used = headParts.reduce((sum, p) => sum + weight(p), 0) +
               tailParts.reduce((sum, p) => sum + weight(p), 0);
  const fill = Math.max(0, 8 - used);
  const all = [...headParts, ...Array(fill).fill('0'), ...tailParts];
  let n = 0n;
  for (const part of all) {
    if (part.includes('.')) {
      const [a, b, c, d] = part.split('.').map(Number);
      n = (n << 32n) | BigInt(((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
    } else {
      n = (n << 16n) | BigInt(parseInt(part || '0', 16));
    }
  }
  return n;
};

const IPV6_LOOPBACK = ipv6ToBigInt('::1');
const IPV6_ULA_LO = ipv6ToBigInt('fc00::0');
const IPV6_ULA_HI = ipv6ToBigInt('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
const IPV6_LL_LO = ipv6ToBigInt('fe80::0');
const IPV6_LL_HI = ipv6ToBigInt('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff');

const isBlockedIpv6 = (ip) => {
  if (net.isIP(ip) !== 6) return false;
  const n = ipv6ToBigInt(ip);
  // IPv4-mapped ::ffff:a.b.c.d (and IPv4-compatible forms, dotted or hex):
  // check the embedded IPv4 against the IPv4 ranges.
  if ((n >> 32n) === 0xffffn) return isBlockedIpv4Int(Number(n & 0xffffffffn));
  if (n === IPV6_LOOPBACK) return true;
  if (n >= IPV6_ULA_LO && n <= IPV6_ULA_HI) return true;
  if (n >= IPV6_LL_LO && n <= IPV6_LL_HI) return true;
  return false;
};

/** True if `ip` (any family) is in a blocked/private/reserved range. */
export const isBlockedIp = (ip) => {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return false;
};

const stripV6Brackets = (host) => host.replace(/^\[|\]$/g, '');

const isBannedHostname = (host) => {
  const h = stripV6Brackets(host).toLowerCase().replace(/\.$/, ''); // strip trailing dot
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal');
};

export class InvalidUrlError extends Error {
  constructor(message) { super(message); this.name = 'InvalidUrlError'; }
}

export class SsrfError extends Error {
  constructor(message) { super(message); this.name = 'SsrfError'; }
}

/**
 * Validate a raw URL string: must be http(s), must have a host, and the
 * hostname itself must not be banned or a blocked literal IP.
 * @returns {URL} the parsed URL
 */
export function validateUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new InvalidUrlError('URL is malformed or missing');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http:// and https:// URLs are allowed');
  }
  if (!url.hostname) throw new InvalidUrlError('URL has no host');
  const host = stripV6Brackets(url.hostname);
  if (isBannedHostname(host)) {
    throw new SsrfError(`Hostname "${host}" is not allowed (reserved/internal hostname)`);
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new SsrfError(`IP address "${host}" is in a blocked private/reserved range`);
  }
  return url;
}

/**
 * Resolve the hostname and refuse the request if ANY resolved address falls
 * in a blocked range (so a public hostname cannot point at internal IPs).
 * Literal IPs are already checked by validateUrl and skip DNS here.
 */
export async function resolveAndCheck(url) {
  const host = stripV6Brackets(url.hostname);
  if (net.isIP(host)) return;
  let addresses;
  try {
    addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new InvalidUrlError(`Could not resolve hostname "${host}"`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new SsrfError(`Hostname "${host}" resolves to blocked address ${address}`);
    }
  }
}