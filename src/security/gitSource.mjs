import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

// [network, prefixLength] — RFC 1918, loopback, link-local, and CGNAT.
const PRIVATE_IPV4_RANGES = [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["0.0.0.0", 8],
];

function ipv4ToInt(ip) {
  return ip
    .split(".")
    .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);

  return PRIVATE_IPV4_RANGES.some(([network, prefixLength]) => {
    const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;

    return (value & mask) === (ipv4ToInt(network) & mask);
  });
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();

  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80") ||
    normalized.startsWith("::ffff:") &&
      isPrivateIPv4(normalized.slice("::ffff:".length))
  );
}

function isPrivateAddress(address) {
  const version = isIP(address);

  if (version === 4) {
    return isPrivateIPv4(address);
  }

  if (version === 6) {
    return isPrivateIPv6(address);
  }

  return true;
}

// Rejects Git sources that could be used for SSRF against the build host's
// internal network, unless explicitly trusted via allowLocal.
export async function validateGitSource(source, { allowLocal = false } = {}) {
  if (!source?.url) {
    throw new Error("project.source.url is required for git sources");
  }

  if (allowLocal) {
    return;
  }

  let parsed;

  try {
    parsed = new URL(source.url);
  } catch {
    throw new Error(
      `Git source URL must be a valid HTTPS URL (local/relative paths require ALLOW_LOCAL_GIT_SOURCES): ${source.url}`,
    );
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `Git source URL must use HTTPS: ${source.url}`,
    );
  }

  const hostname = parsed.hostname;

  if (hostname === "localhost") {
    throw new Error("Git source URL must not target localhost");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(
        `Git source URL resolves to a private/internal address: ${hostname}`,
      );
    }

    return;
  }

  let addresses;

  try {
    addresses = await lookup(hostname, { all: true });
  } catch (error) {
    throw new Error(`Could not resolve Git source host "${hostname}": ${error.message}`);
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(
        `Git source host "${hostname}" resolves to a private/internal address (${address})`,
      );
    }
  }
}
