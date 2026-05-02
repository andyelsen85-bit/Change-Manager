import forge from "node-forge";

export type CsrSubject = {
  commonName: string;
  organization?: string;
  organizationalUnit?: string;
  locality?: string;
  state?: string;
  country?: string;
  emailAddress?: string;
};

export type CsrInput = CsrSubject & {
  // RFC 5280 Subject Alternative Names. DNS names by default; entries that look
  // like IPv4/IPv6 addresses are encoded as IP SANs.
  subjectAltNames?: string[];
  keyBits?: 2048 | 3072 | 4096;
};

export type CsrResult = {
  csrPem: string;
  privateKeyPem: string;
  publicKeyFingerprintSha256: string;
  subject: CsrSubject;
  subjectAltNames: string[];
  keyBits: number;
};

const COUNTRY_RE = /^[A-Za-z]{2}$/;

function isIpAddress(s: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split(".").every((p) => {
      const n = Number(p);
      return n >= 0 && n <= 255;
    });
  }
  // Crude IPv6 detection — colons + hex.
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(":");
}

function buildSubjectAttrs(s: CsrSubject): forge.pki.CertificateField[] {
  const attrs: forge.pki.CertificateField[] = [];
  if (!s.commonName || !s.commonName.trim()) {
    throw new Error("commonName is required");
  }
  attrs.push({ name: "commonName", value: s.commonName.trim() });
  if (s.country) {
    if (!COUNTRY_RE.test(s.country)) {
      throw new Error("country must be a 2-letter ISO code (e.g. 'US', 'DE')");
    }
    attrs.push({ name: "countryName", value: s.country.toUpperCase() });
  }
  if (s.state) attrs.push({ shortName: "ST", value: s.state });
  if (s.locality) attrs.push({ name: "localityName", value: s.locality });
  if (s.organization) attrs.push({ name: "organizationName", value: s.organization });
  if (s.organizationalUnit) attrs.push({ shortName: "OU", value: s.organizationalUnit });
  if (s.emailAddress) attrs.push({ name: "emailAddress", value: s.emailAddress });
  return attrs;
}

export function generateCsr(input: CsrInput): CsrResult {
  const keyBits = input.keyBits ?? 2048;
  if (![2048, 3072, 4096].includes(keyBits)) {
    throw new Error("keyBits must be 2048, 3072, or 4096");
  }
  const subjectAttrs = buildSubjectAttrs(input);
  const sans = (input.subjectAltNames ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Always include the CN itself in the SAN list (most CAs require this for TLS certs).
  if (!sans.includes(input.commonName.trim())) {
    sans.unshift(input.commonName.trim());
  }
  const altNames = sans.map((s) =>
    isIpAddress(s) ? { type: 7, ip: s } : { type: 2, value: s },
  );

  const keys = forge.pki.rsa.generateKeyPair({ bits: keyBits });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject(subjectAttrs);
  csr.setAttributes([
    {
      name: "extensionRequest",
      extensions: [
        {
          name: "subjectAltName",
          altNames,
        },
        {
          name: "keyUsage",
          critical: true,
          digitalSignature: true,
          keyEncipherment: true,
        },
        {
          name: "extKeyUsage",
          serverAuth: true,
          clientAuth: false,
        },
      ],
    },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());

  const csrPem = forge.pki.certificationRequestToPem(csr);
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  // Fingerprint of the SubjectPublicKeyInfo DER (sha256, hex, colon-separated) for verification
  const spkiDer = forge.asn1
    .toDer(forge.pki.publicKeyToAsn1(keys.publicKey))
    .getBytes();
  const md = forge.md.sha256.create();
  md.update(spkiDer);
  const hexHash = md.digest().toHex();
  const publicKeyFingerprintSha256 = (hexHash.match(/.{2}/g) ?? []).join(":");

  return {
    csrPem,
    privateKeyPem,
    publicKeyFingerprintSha256,
    subject: {
      commonName: input.commonName.trim(),
      organization: input.organization,
      organizationalUnit: input.organizationalUnit,
      locality: input.locality,
      state: input.state,
      country: input.country?.toUpperCase(),
      emailAddress: input.emailAddress,
    },
    subjectAltNames: sans,
    keyBits,
  };
}
