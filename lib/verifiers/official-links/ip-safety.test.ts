import { describe, expect, it } from "vitest";
import {
  IANA_REGISTRY_SNAPSHOT_DATE,
  classifyIpAddress,
  ipAddressesEqual,
  normalizeIpAddress,
} from "./ip-safety";

describe("normalizeIpAddress", () => {
  it.each([
    ["8.8.8.8", { address: "8.8.8.8", family: 4 }],
    ["2606:4700:4700::1111", { address: "2606:4700:4700::1111", family: 6 }],
    ["2606:4700:4700:0000:0000:0000:0000:1111", { address: "2606:4700:4700::1111", family: 6 }],
    ["2606:4700:0000:0000:0000:0000:4700:1111", { address: "2606:4700::4700:1111", family: 6 }],
    ["2001:0DB8:0000:0000:0001:0000:0000:0001", { address: "2001:db8::1:0:0:1", family: 6 }],
    ["::FFFF:8.8.4.4", { address: "8.8.4.4", family: 4 }],
    ["0:0:0:0:0:ffff:c000:0201", { address: "192.0.2.1", family: 4 }],
  ] as const)("canonicalizes %s", (input, expected) => {
    expect(normalizeIpAddress(input)).toEqual(expected);
  });

  it.each([
    "",
    "not-an-ip",
    " 8.8.8.8",
    "8.8.8.8 ",
    "127.000.000.001",
    "1.2.3",
    "[2606:4700:4700::1111]",
    "fe80::1%eth0",
    "fe80::1%25eth0",
    "2606:4700:4700::1111%eth0",
    "2001:db8:::1",
  ])("rejects invalid or zone-qualified input %s", (input) => {
    expect(normalizeIpAddress(input)).toBeNull();
  });

  it("uses the leftmost longest zero run for canonical IPv6 compression", () => {
    expect(normalizeIpAddress("2001:0:0:1:0:0:1:1")).toEqual({
      address: "2001::1:0:0:1:1",
      family: 6,
    });
  });
});

describe("classifyIpAddress", () => {
  it("pins the special-purpose registry snapshot used by the policy", () => {
    expect(IANA_REGISTRY_SNAPSHOT_DATE).toBe("2025-10-09");
  });

  it.each([
    ["0.0.0.0/8", "0.0.0.0", "0.255.255.255"],
    ["0.0.0.0/32", "0.0.0.0", "0.0.0.0"],
    ["10.0.0.0/8", "10.0.0.0", "10.255.255.255"],
    ["100.64.0.0/10", "100.64.0.0", "100.127.255.255"],
    ["127.0.0.0/8", "127.0.0.0", "127.255.255.255"],
    ["169.254.0.0/16", "169.254.0.0", "169.254.255.255"],
    ["172.16.0.0/12", "172.16.0.0", "172.31.255.255"],
    ["192.0.0.0/24", "192.0.0.0", "192.0.0.255"],
    ["192.0.0.0/29", "192.0.0.0", "192.0.0.7"],
    ["192.0.0.8/32", "192.0.0.8", "192.0.0.8"],
    ["192.0.0.9/32", "192.0.0.9", "192.0.0.9"],
    ["192.0.0.10/32", "192.0.0.10", "192.0.0.10"],
    ["192.0.0.170/32", "192.0.0.170", "192.0.0.170"],
    ["192.0.0.171/32", "192.0.0.171", "192.0.0.171"],
    ["192.0.2.0/24", "192.0.2.0", "192.0.2.255"],
    ["192.31.196.0/24", "192.31.196.0", "192.31.196.255"],
    ["192.52.193.0/24", "192.52.193.0", "192.52.193.255"],
    ["192.88.99.0/24", "192.88.99.0", "192.88.99.255"],
    ["192.88.99.2/32", "192.88.99.2", "192.88.99.2"],
    ["192.168.0.0/16", "192.168.0.0", "192.168.255.255"],
    ["192.175.48.0/24", "192.175.48.0", "192.175.48.255"],
    ["198.18.0.0/15", "198.18.0.0", "198.19.255.255"],
    ["198.51.100.0/24", "198.51.100.0", "198.51.100.255"],
    ["203.0.113.0/24", "203.0.113.0", "203.0.113.255"],
    ["224.0.0.0/4", "224.0.0.0", "239.255.255.255"],
    ["240.0.0.0/4", "240.0.0.0", "255.255.255.255"],
    ["255.255.255.255/32", "255.255.255.255", "255.255.255.255"],
  ])("denies both boundaries of pinned IPv4 range %s", (_cidr, first, last) => {
    expect(classifyIpAddress(first)).toEqual({
      safe: false,
      value: { address: first, family: 4 },
      reason: "special_use",
    });
    expect(classifyIpAddress(last)).toEqual({
      safe: false,
      value: { address: last, family: 4 },
      reason: "special_use",
    });
  });

  it.each([
    ["0.0.0.0/8 upper", "1.0.0.0"],
    ["10.0.0.0/8 lower", "9.255.255.255"],
    ["10.0.0.0/8 upper", "11.0.0.0"],
    ["100.64.0.0/10 lower", "100.63.255.255"],
    ["100.64.0.0/10 upper", "100.128.0.0"],
    ["127.0.0.0/8 lower", "126.255.255.255"],
    ["127.0.0.0/8 upper", "128.0.0.0"],
    ["169.254.0.0/16 lower", "169.253.255.255"],
    ["169.254.0.0/16 upper", "169.255.0.0"],
    ["172.16.0.0/12 lower", "172.15.255.255"],
    ["172.16.0.0/12 upper", "172.32.0.0"],
    ["192.0.0.0/24 lower", "191.255.255.255"],
    ["192.0.0.0/24 upper", "192.0.1.0"],
    ["192.0.2.0/24 lower", "192.0.1.255"],
    ["192.0.2.0/24 upper", "192.0.3.0"],
    ["192.31.196.0/24 lower", "192.31.195.255"],
    ["192.31.196.0/24 upper", "192.31.197.0"],
    ["192.52.193.0/24 lower", "192.52.192.255"],
    ["192.52.193.0/24 upper", "192.52.194.0"],
    ["192.88.99.0/24 lower", "192.88.98.255"],
    ["192.88.99.0/24 upper", "192.88.100.0"],
    ["192.168.0.0/16 lower", "192.167.255.255"],
    ["192.168.0.0/16 upper", "192.169.0.0"],
    ["192.175.48.0/24 lower", "192.175.47.255"],
    ["192.175.48.0/24 upper", "192.175.49.0"],
    ["198.18.0.0/15 lower", "198.17.255.255"],
    ["198.18.0.0/15 upper", "198.20.0.0"],
    ["198.51.100.0/24 lower", "198.51.99.255"],
    ["198.51.100.0/24 upper", "198.51.101.0"],
    ["203.0.113.0/24 lower", "203.0.112.255"],
    ["203.0.113.0/24 upper", "203.0.114.0"],
    ["224.0.0.0/4 lower", "223.255.255.255"],
  ])("allows the public adjacent IPv4 address at %s", (_boundary, address) => {
    expect(classifyIpAddress(address)).toEqual({
      safe: true,
      value: { address, family: 4 },
    });
  });

  it.each([
    ["0.0.0.0/8", ["1.0.0.0", true]],
    ["0.0.0.0/32", ["0.0.0.1", false]],
    ["10.0.0.0/8", ["9.255.255.255", true], ["11.0.0.0", true]],
    ["100.64.0.0/10", ["100.63.255.255", true], ["100.128.0.0", true]],
    ["127.0.0.0/8", ["126.255.255.255", true], ["128.0.0.0", true]],
    ["169.254.0.0/16", ["169.253.255.255", true], ["169.255.0.0", true]],
    ["172.16.0.0/12", ["172.15.255.255", true], ["172.32.0.0", true]],
    ["192.0.0.0/24", ["191.255.255.255", true], ["192.0.1.0", true]],
    ["192.0.0.0/29", ["191.255.255.255", true], ["192.0.0.8", false]],
    ["192.0.0.8/32", ["192.0.0.7", false], ["192.0.0.9", false]],
    ["192.0.0.9/32", ["192.0.0.8", false], ["192.0.0.10", false]],
    ["192.0.0.10/32", ["192.0.0.9", false], ["192.0.0.11", false]],
    ["192.0.0.170/32", ["192.0.0.169", false], ["192.0.0.171", false]],
    ["192.0.0.171/32", ["192.0.0.170", false], ["192.0.0.172", false]],
    ["192.0.2.0/24", ["192.0.1.255", true], ["192.0.3.0", true]],
    ["192.31.196.0/24", ["192.31.195.255", true], ["192.31.197.0", true]],
    ["192.52.193.0/24", ["192.52.192.255", true], ["192.52.194.0", true]],
    ["192.88.99.0/24", ["192.88.98.255", true], ["192.88.100.0", true]],
    ["192.88.99.2/32", ["192.88.99.1", false], ["192.88.99.3", false]],
    ["192.168.0.0/16", ["192.167.255.255", true], ["192.169.0.0", true]],
    ["192.175.48.0/24", ["192.175.47.255", true], ["192.175.49.0", true]],
    ["198.18.0.0/15", ["198.17.255.255", true], ["198.20.0.0", true]],
    ["198.51.100.0/24", ["198.51.99.255", true], ["198.51.101.0", true]],
    ["203.0.113.0/24", ["203.0.112.255", true], ["203.0.114.0", true]],
    ["224.0.0.0/4", ["223.255.255.255", true], ["240.0.0.0", false]],
    ["240.0.0.0/4", ["239.255.255.255", false]],
    ["255.255.255.255/32", ["255.255.255.254", false]],
  ] as const)("classifies every valid adjacent address for IPv4 range %s", (_cidr, ...adjacent) => {
    for (const entry of adjacent) {
      const [address, safe] = entry as readonly [string, boolean];
      expect(classifyIpAddress(address).safe).toBe(safe);
    }
  });

  it.each([
    ["::/128", "::", "::"],
    ["::1/128", "::1", "::1"],
    ["64:ff9b::/96", "64:ff9b::", "64:ff9b::ffff:ffff"],
    ["64:ff9b:1::/48", "64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"],
    ["100::/64", "100::", "100::ffff:ffff:ffff:ffff"],
    ["100:0:0:1::/64", "100:0:0:1::", "100::1:ffff:ffff:ffff:ffff"],
    ["2001::/23", "2001::", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001::/32", "2001::", "2001::ffff:ffff:ffff:ffff"],
    ["2001:1::1/128", "2001:1::1", "2001:1::1"],
    ["2001:1::2/128", "2001:1::2", "2001:1::2"],
    ["2001:1::3/128", "2001:1::3", "2001:1::3"],
    ["2001:2::/48", "2001:2::", "2001:2:0:ffff:ffff:ffff:ffff:ffff"],
    ["2001:3::/32", "2001:3::", "2001:3:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:4:112::/48", "2001:4:112::", "2001:4:112:ffff:ffff:ffff:ffff:ffff"],
    ["2001:10::/28", "2001:10::", "2001:1f:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:20::/28", "2001:20::", "2001:2f:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:30::/28", "2001:30::", "2001:3f:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:db8::/32", "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2002::/16", "2002::", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2620:4f:8000::/48", "2620:4f:8000::", "2620:4f:8000:ffff:ffff:ffff:ffff:ffff"],
    ["3fff::/20", "3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["5f00::/16", "5f00::", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["fc00::/7", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["fe80::/10", "fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["ff00::/8", "ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ])("denies both boundaries of pinned IPv6 range %s", (_cidr, first, last) => {
    expect(classifyIpAddress(first)).toEqual({
      safe: false,
      value: { address: first, family: 6 },
      reason: "special_use",
    });
    expect(classifyIpAddress(last)).toEqual({
      safe: false,
      value: { address: last, family: 6 },
      reason: "special_use",
    });
  });

  it.each([
    ["2001::/23 lower", "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001::/23 upper", "2001:200::"],
    ["2001:db8::/32 lower", "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:db8::/32 upper", "2001:db9::"],
    ["2002::/16 lower", "2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2002::/16 upper", "2003::"],
    ["2620:4f:8000::/48 lower", "2620:4f:7fff:ffff:ffff:ffff:ffff:ffff"],
    ["2620:4f:8000::/48 upper", "2620:4f:8001::"],
    ["3fff::/20 lower", "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ])("allows the public adjacent IPv6 address at %s", (_boundary, address) => {
    expect(classifyIpAddress(address)).toEqual({
      safe: true,
      value: { address, family: 6 },
    });
  });

  it.each([
    ["::/128", ["::1", false]],
    ["::1/128", ["::", false], ["::2", false]],
    ["64:ff9b::/96", ["64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff", false], ["64:ff9b::1:0:0", false]],
    ["64:ff9b:1::/48", ["64:ff9b:0:ffff:ffff:ffff:ffff:ffff", false], ["64:ff9b:2::", false]],
    ["100::/64", ["ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["100:0:0:1::", false]],
    ["100:0:0:1::/64", ["100::ffff:ffff:ffff:ffff", false], ["100:0:0:2::", false]],
    ["2001::/23", ["2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:200::", true]],
    ["2001::/32", ["2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:1::", false]],
    ["2001:1::1/128", ["2001:1::", false], ["2001:1::2", false]],
    ["2001:1::2/128", ["2001:1::1", false], ["2001:1::3", false]],
    ["2001:1::3/128", ["2001:1::2", false], ["2001:1::4", false]],
    ["2001:2::/48", ["2001:1:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2001:3::", false]],
    ["2001:3::/32", ["2001:2:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2001:4::", false]],
    ["2001:4:112::/48", ["2001:4:111:ffff:ffff:ffff:ffff:ffff", false], ["2001:4:113::", false]],
    ["2001:10::/28", ["2001:f:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2001:20::", false]],
    ["2001:20::/28", ["2001:1f:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2001:30::", false]],
    ["2001:30::/28", ["2001:2f:ffff:ffff:ffff:ffff:ffff:ffff", false], ["2001:40::", false]],
    ["2001:db8::/32", ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2001:db9::", true]],
    ["2002::/16", ["2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["2003::", true]],
    ["2620:4f:8000::/48", ["2620:4f:7fff:ffff:ffff:ffff:ffff:ffff", true], ["2620:4f:8001::", true]],
    ["3fff::/20", ["3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true], ["4000::", false]],
    ["5f00::/16", ["5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["5f01::", false]],
    ["fc00::/7", ["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["fe00::", false]],
    ["fe80::/10", ["fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false], ["fec0::", false]],
    ["ff00::/8", ["feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", false]],
  ] as const)("classifies every valid adjacent address for IPv6 range %s", (_cidr, ...adjacent) => {
    for (const entry of adjacent) {
      const [address, safe] = entry as readonly [string, boolean];
      expect(classifyIpAddress(address).safe).toBe(safe);
    }
  });

  it.each([
    "4000::",
    "5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "5f01::",
    "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fec0::1",
  ])("denies IPv6 outside global-unicast space even when not in a named registry block: %s", (address) => {
    expect(classifyIpAddress(address)).toEqual({
      safe: false,
      value: { address, family: 6 },
      reason: "special_use",
    });
  });

  it.each([
    ["::ffff:8.8.8.8", true, "8.8.8.8"],
    ["::FFFF:0808:0404", true, "8.8.4.4"],
    ["::ffff:10.0.0.1", false, "10.0.0.1"],
    ["0:0:0:0:0:ffff:7f00:1", false, "127.0.0.1"],
    ["::ffff:a9fe:a9fe", false, "169.254.169.254"],
    ["::ffff:6440:1", false, "100.64.0.1"],
  ] as const)("applies IPv4 policy to mapped IPv6 %s", (input, safe, address) => {
    const result = classifyIpAddress(input);

    expect(result.safe).toBe(safe);
    expect(result.value).toEqual({ address, family: 4 });
    if (!safe) {
      expect(result).toHaveProperty("reason", "special_use");
    }
  });

  it("extracts both boundaries of the IPv4-mapped IPv6 registry block", () => {
    expect(classifyIpAddress("::ffff:0:0")).toEqual({
      safe: false,
      value: { address: "0.0.0.0", family: 4 },
      reason: "special_use",
    });
    expect(classifyIpAddress("::ffff:ffff:ffff")).toEqual({
      safe: false,
      value: { address: "255.255.255.255", family: 4 },
      reason: "special_use",
    });
    expect(classifyIpAddress("::fffe:ffff:ffff").safe).toBe(false);
    expect(classifyIpAddress("::1:0:0:0").safe).toBe(false);
  });

  it.each(["", "garbage", "fe80::1%en0", "999.1.1.1"])(
    "fails closed without echoing an unparseable address: %s",
    (input) => {
      expect(classifyIpAddress(input)).toEqual({
        safe: false,
        value: null,
        reason: "invalid",
      });
    },
  );
});

describe("ipAddressesEqual", () => {
  it.each([
    ["2606:4700:4700::1111", "2606:4700:4700:0:0:0:0:1111", true],
    ["2606:4700:4700::1111", "2606:4700:4700::1001", false],
    ["8.8.8.8", "::ffff:8.8.8.8", true],
    ["8.8.8.8", "::ffff:0808:0808", true],
    ["8.8.8.8", "8.8.4.4", false],
    ["invalid", "invalid", false],
    ["fe80::1%eth0", "fe80::1", false],
  ] as const)("compares %s and %s semantically", (left, right, expected) => {
    expect(ipAddressesEqual(left, right)).toBe(expected);
  });
});
