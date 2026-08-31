/**
 * Regenerate the development TLS certificate.
 *
 *   node scripts/dev-cert.mjs
 *
 * WHY THIS IS NEEDED AT ALL. A microphone requires a secure origin. On plain
 * HTTP `navigator.mediaDevices` is `undefined`, so on a phone at
 * `http://192.168.x.x:3000` no speech engine can capture anything — it reports
 * "voice input is unavailable" before it reaches a microphone. `localhost` is
 * exempt from that rule, which is why this passes every desktop test and fails
 * on the only device that matters.
 *
 * WHY REGENERATE. The committed certificate covers `localhost` and `127.0.0.1`
 * only. A phone reaches this machine by LAN address, so the browser reports a
 * name mismatch on top of the untrusted-issuer warning — two scary screens
 * instead of one, and on some Android builds a name mismatch is the harder of
 * the two to click past. This writes a cert whose SAN list includes every local
 * IPv4 address, so only the issuer warning remains.
 *
 * Re-run it when the machine changes network and picks up a new address.
 *
 * The certificate stays SELF-SIGNED and therefore untrusted: the phone will
 * still ask you to proceed once. That is expected, and it does not weaken the
 * secure-context guarantee — once you proceed, the origin is `https://`,
 * `isSecureContext` is true, and getUserMedia works. Installing a real CA on
 * the phone is the only way to remove that prompt, and it is not worth it for
 * a dev loop.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const DIR = join(process.cwd(), "certificates");
const KEY = join(DIR, "localhost-key.pem");
const CERT = join(DIR, "localhost.pem");

/** Every address a phone on the same network could reach this machine by. */
function localAddresses() {
  const out = new Set(["127.0.0.1"]);
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) out.add(net.address);
    }
  }
  return [...out];
}

const ips = localAddresses();
const san = ["DNS:localhost", ...ips.map((ip) => `IP:${ip}`)].join(",");

mkdirSync(DIR, { recursive: true });

// Keep whatever was there. These are dev certs, but silently destroying a
// working local setup to fix a warning is a bad trade.
for (const file of [KEY, CERT]) {
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
}

const config = join(DIR, "openssl.cnf");
writeFileSync(
  config,
  `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
O = Vision Access development certificate
CN = localhost

[ext]
subjectAltName = ${san}
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
`,
  "utf8",
);

try {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256",
      "-days", "825", "-nodes",
      "-keyout", KEY,
      "-out", CERT,
      "-config", config,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
} finally {
  rmSync(config, { force: true });
}

console.log("Development certificate regenerated.\n");
console.log(`  covers : localhost, ${ips.join(", ")}`);
console.log(`  key    : certificates/localhost-key.pem`);
console.log(`  cert   : certificates/localhost.pem`);
console.log(`  backup : *.pem.bak\n`);
console.log("Start the app with:  npm run dev");
for (const ip of ips.filter((i) => i !== "127.0.0.1")) {
  console.log(`Then open on the phone:  https://${ip}:3000/bus/wait`);
}
console.log("\nThe phone will warn once that the issuer is untrusted — proceed anyway.");
console.log("The origin is still https://, which is what the microphone requires.");
