/**
 * Optional Let's Encrypt certificate management via ACME.
 * Uses HTTP-01 challenge - requires port 80 to be publicly accessible.
 */
import acme from "acme-client";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

/**
 * Parse boolean env var.
 */
function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  return ["true", "1", "yes", "y"].includes(String(value).toLowerCase());
}

/**
 * Check if Let's Encrypt is enabled via environment.
 */
export function isLetsEncryptEnabled() {
  return parseBoolean(process.env.LETSENCRYPT_ENABLED, false);
}

/**
 * Get Let's Encrypt configuration from environment.
 */
export function getLetsEncryptConfig() {
  const domain = process.env.LETSENCRYPT_DOMAIN || "";
  const domains = domain
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const email = process.env.LETSENCRYPT_EMAIL || "";
  const certDir =
    process.env.LETSENCRYPT_CERT_DIR || "/app/letsencrypt";
  const staging = parseBoolean(process.env.LETSENCRYPT_STAGING, false);

  return {
    domains,
    email,
    certDir,
    staging,
    directoryUrl: staging ? STAGING_DIRECTORY : PRODUCTION_DIRECTORY,
  };
}

/**
 * Get paths for certificate files.
 */
function getCertPaths(certDir, primaryDomain) {
  const safe = (primaryDomain || "cert").replace(/[^a-zA-Z0-9.-]/g, "_");
  return {
    cert: path.join(certDir, `${safe}-cert.pem`),
    key: path.join(certDir, `${safe}-key.pem`),
    fullchain: path.join(certDir, `${safe}-fullchain.pem`),
  };
}

/**
 * Check if valid certificate files exist and are not expired.
 * Treats certs expiring within 14 days as invalid (triggers renewal).
 */
export async function hasValidCert(certDir, primaryDomain) {
  const paths = getCertPaths(certDir, primaryDomain);
  try {
    const [certExists, keyExists] = await Promise.all([
      fsPromises.access(paths.fullchain, fs.constants.R_OK).then(() => true).catch(() => false),
      fsPromises.access(paths.key, fs.constants.R_OK).then(() => true).catch(() => false),
    ]);
    if (!certExists || !keyExists) return false;
    const certPem = await fsPromises.readFile(paths.fullchain, "utf8");
    const info = acme.crypto.readCertificateInfo(certPem);
    const now = new Date();
    const renewThreshold = 14 * 24 * 60 * 60 * 1000; // 14 days
    return info.notAfter && new Date(info.notAfter) > new Date(now.getTime() + renewThreshold);
  } catch {
    return false;
  }
}

/**
 * Get certificate and key for HTTPS server.
 * Returns { cert, key } buffers or null if not available.
 */
export async function loadCertForHttps(certDir, primaryDomain) {
  const paths = getCertPaths(certDir, primaryDomain);
  try {
    const [cert, key] = await Promise.all([
      fsPromises.readFile(paths.fullchain),
      fsPromises.readFile(paths.key),
    ]);
    return { cert, key };
  } catch {
    return null;
  }
}

/**
 * Challenge store for HTTP-01: token -> keyAuthorization
 * Used during certificate issuance.
 */
const challengeStore = new Map();

/**
 * Set when HTTPS server is ready (for redirect middleware).
 */
let httpsReady = false;

export function setLetsEncryptHttpsReady(ready) {
  httpsReady = ready;
}

export function isLetsEncryptHttpsReady() {
  return httpsReady;
}

/**
 * Register a challenge for HTTP-01 validation.
 * Call this before completeChallenge.
 */
export function setChallenge(token, keyAuthorization) {
  challengeStore.set(token, keyAuthorization);
}

/**
 * Get challenge response for a token (for serving /.well-known/acme-challenge/:token).
 */
export function getChallenge(token) {
  return challengeStore.get(token) || null;
}

/**
 * Clear challenge after completion.
 */
export function clearChallenge(token) {
  challengeStore.delete(token);
}

/**
 * Obtain a certificate from Let's Encrypt using HTTP-01 challenge.
 * Requires the app to be serving HTTP on port 80 with the challenge route.
 *
 * @param {Object} config - From getLetsEncryptConfig()
 * @returns {Promise<{cert: Buffer, key: Buffer}>}
 */
export async function obtainCertificate(config) {
  const { domains, email, certDir, directoryUrl } = config;

  if (domains.length === 0) {
    throw new Error("LETSENCRYPT_DOMAIN must be set (e.g. example.com or a.example.com,b.example.com)");
  }
  if (!email) {
    throw new Error("LETSENCRYPT_EMAIL is required by Let's Encrypt");
  }

  await fsPromises.mkdir(certDir, { recursive: true });

  const accountKey = await acme.crypto.createPrivateKey();
  const client = new acme.Client({
    directoryUrl,
    accountKey,
  });

  await client.createAccount({
    termsOfServiceAgreed: true,
    contact: [`mailto:${email}`],
  });

  const identifiers = domains.map((d) => ({ type: "dns", value: d }));
  const order = await client.createOrder({ identifiers });

  const authzList = await client.getAuthorizations(order);
  const http01Challenges = [];

  for (const authz of authzList) {
    const challenge = authz.challenges.find((c) => c.type === "http-01");
    if (!challenge) {
      throw new Error(`No HTTP-01 challenge for ${authz.identifier.value}`);
    }
    const keyAuthz = await client.getChallengeKeyAuthorization(challenge);
    const token = challenge.token;
    setChallenge(token, keyAuthz);
    http01Challenges.push({ challenge });
  }

  try {
    await Promise.all(
      http01Challenges.map(({ challenge }) => client.completeChallenge(challenge))
    );

    await client.waitForValidStatus(order);

    const [keyPem, csrPem] = await acme.crypto.createCsr({
      commonName: domains[0],
      altNames: domains,
    });

    await client.finalizeOrder(order, csrPem);
    const certPem = await client.getCertificate(order);

    const primaryDomain = domains[0];
    const paths = getCertPaths(certDir, primaryDomain);

    const certStr = typeof certPem === "string" ? certPem : certPem.toString("utf8");
    const keyStr = Buffer.isBuffer(keyPem) ? keyPem.toString("utf8") : keyPem;

    await fsPromises.writeFile(paths.cert, certStr, "utf8");
    await fsPromises.writeFile(paths.key, keyStr, "utf8");
    await fsPromises.writeFile(paths.fullchain, certStr, "utf8");

    return {
      cert: Buffer.from(certStr, "utf8"),
      key: Buffer.from(keyStr, "utf8"),
    };
  } finally {
    for (const { challenge } of http01Challenges) {
      clearChallenge(challenge.token);
    }
  }
}
