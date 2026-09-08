import { isIP } from "node:net";

export type NormalizedIpAddress = { address: string; family: 4 | 6 };

export type IpSafetyDecision =
  | { safe: true; value: NormalizedIpAddress }
  | {
      safe: false;
      value: NormalizedIpAddress | null;
      reason: "invalid" | "special_use";
    };

export const IANA_REGISTRY_SNAPSHOT_DATE = "2025-10-09";

type ParsedIpAddress = NormalizedIpAddress & { numericValue: bigint };
type CidrRange = { network: bigint; prefixLength: number; width: 32 | 128 };

// Pinned from the IANA IPv4 Special-Purpose Address Space registry dated
// 2025-10-09 (iana.org/assignments/iana-ipv4-special-registry). Multicast is
// added because it is not part of that registry.
const IPV4_DENY_CIDRS = [
  "0.0.0.0/8",
  "0.0.0.0/32",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.0.0/29",
  "192.0.0.8/32",
  "192.0.0.9/32",
  "192.0.0.10/32",
  "192.0.0.170/32",
  "192.0.0.171/32",
  "192.0.2.0/24",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.88.99.0/24",
  "192.88.99.2/32",
  "192.168.0.0/16",
  "192.175.48.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
] as const;

// Pinned from the IANA IPv6 Special-Purpose Address Space registry dated
// 2025-10-09 (iana.org/assignments/iana-ipv6-special-registry). The registry's
// ::ffff:0:0/96 block is extracted before this table is used so its embedded
// IPv4 value receives the full IPv4 policy. Multicast is added because it is
// defined by the IPv6 addressing architecture.
const IPV6_DENY_CIDRS = [
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "100:0:0:1::/64",
  "2001::/23",
  "2001::/32",
  "2001:1::1/128",
  "2001:1::2/128",
  "2001:1::3/128",
  "2001:2::/48",
  "2001:3::/32",
  "2001:4:112::/48",
  "2001:10::/28",
  "2001:20::/28",
  "2001:30::/28",
  "2001:db8::/32",
  "2002::/16",
  "2620:4f:8000::/48",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
] as const;

function ipv4BytesToBigInt(bytes: readonly number[]): bigint {
  return bytes.reduce(
    (value, byte) => (value << BigInt(8)) | BigInt(byte),
    BigInt(0),
  );
}

function ipv6GroupsToBigInt(groups: readonly number[]): bigint {
  return groups.reduce(
    (value, group) => (value << BigInt(16)) | BigInt(group),
    BigInt(0),
  );
}

function parseIpv4(input: string): ParsedIpAddress | null {
  if (isIP(input) !== 4) return null;

  const bytes = input.split(".").map(Number);
  return {
    address: bytes.join("."),
    family: 4,
    numericValue: ipv4BytesToBigInt(bytes),
  };
}

function parseIpv6Groups(input: string): number[] | null {
  if (input.includes("%") || isIP(input) !== 6) return null;

  let hexadecimal = input.toLowerCase();
  if (hexadecimal.includes(".")) {
    const lastColon = hexadecimal.lastIndexOf(":");
    const dotted = hexadecimal.slice(lastColon + 1);
    const ipv4 = parseIpv4(dotted);
    if (lastColon < 0 || ipv4 === null) return null;

    const bytes = dotted.split(".").map(Number);
    const highGroup = (bytes[0] * 256 + bytes[1]).toString(16);
    const lowGroup = (bytes[2] * 256 + bytes[3]).toString(16);
    hexadecimal = `${hexadecimal.slice(0, lastColon)}:${highGroup}:${lowGroup}`;
  }

  const halves = hexadecimal.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - left.length - right.length;

  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;

  const groups = [
    ...left.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((group) => Number.parseInt(group, 16)),
  ];

  return groups.length === 8 ? groups : null;
}

function canonicalizeIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;

  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < groups.length && groups[end] === 0) end += 1;
    const length = end - index;
    if (length >= 2 && length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }

  const parts = groups.map((group) => group.toString(16));
  if (bestStart < 0) return parts.join(":");

  const before = parts.slice(0, bestStart).join(":");
  const after = parts.slice(bestStart + bestLength).join(":");
  if (before === "" && after === "") return "::";
  if (before === "") return `::${after}`;
  if (after === "") return `${before}::`;
  return `${before}::${after}`;
}

function parseIpAddress(input: string): ParsedIpAddress | null {
  const ipv4 = parseIpv4(input);
  if (ipv4 !== null) return ipv4;

  const groups = parseIpv6Groups(input);
  if (groups === null) return null;

  const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isIpv4Mapped) {
    const bytes = [
      groups[6] >>> 8,
      groups[6] & 0xff,
      groups[7] >>> 8,
      groups[7] & 0xff,
    ];
    return {
      address: bytes.join("."),
      family: 4,
      numericValue: ipv4BytesToBigInt(bytes),
    };
  }

  return {
    address: canonicalizeIpv6(groups),
    family: 6,
    numericValue: ipv6GroupsToBigInt(groups),
  };
}

function parseCidr(cidr: string): CidrRange {
  const [address, rawPrefixLength] = cidr.split("/");
  const parsed = parseIpAddress(address);
  const prefixLength = Number(rawPrefixLength);

  if (parsed === null) throw new Error(`Invalid pinned CIDR: ${cidr}`);

  return {
    network: parsed.numericValue,
    prefixLength,
    width: parsed.family === 4 ? 32 : 128,
  };
}

const IPV4_DENY_RANGES = IPV4_DENY_CIDRS.map(parseCidr);
const IPV6_DENY_RANGES = IPV6_DENY_CIDRS.map(parseCidr);
const IPV6_GLOBAL_UNICAST_RANGE = parseCidr("2000::/3");

function isInCidr(value: bigint, range: CidrRange): boolean {
  const hostBits = BigInt(range.width - range.prefixLength);
  return value >> hostBits === range.network >> hostBits;
}

export function normalizeIpAddress(input: string): NormalizedIpAddress | null {
  const parsed = parseIpAddress(input);
  if (parsed === null) return null;

  return { address: parsed.address, family: parsed.family };
}

export function classifyIpAddress(input: string): IpSafetyDecision {
  const parsed = parseIpAddress(input);
  if (parsed === null) {
    return { safe: false, value: null, reason: "invalid" };
  }

  const value: NormalizedIpAddress = {
    address: parsed.address,
    family: parsed.family,
  };
  const denied = parsed.family === 4
    ? IPV4_DENY_RANGES.some((range) => isInCidr(parsed.numericValue, range))
    : !isInCidr(parsed.numericValue, IPV6_GLOBAL_UNICAST_RANGE) ||
      IPV6_DENY_RANGES.some((range) => isInCidr(parsed.numericValue, range));

  return denied
    ? { safe: false, value, reason: "special_use" }
    : { safe: true, value };
}

export function ipAddressesEqual(left: string, right: string): boolean {
  const parsedLeft = parseIpAddress(left);
  const parsedRight = parseIpAddress(right);

  return parsedLeft !== null &&
    parsedRight !== null &&
    parsedLeft.family === parsedRight.family &&
    parsedLeft.numericValue === parsedRight.numericValue;
}
