import { generateKeyPairSync, sign } from "node:crypto"

/** The DER encoding of a value: its tag, its length, its content. */
const der = (tag: number, ...parts: ReadonlyArray<Uint8Array>): Buffer => {
  const content = Buffer.concat(parts)
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

/** The shortest form DER allows: strict parsers such as BoringSSL's refuse a longer one. */
const derLength = (length: number): Buffer => {
  if (length < 0x80) return Buffer.from([length])
  if (length < 0x100) return Buffer.from([0x81, length])
  return Buffer.from([0x82, length >> 8, length & 0xff])
}

const SEQUENCE = 0x30
const SET = 0x31
const INTEGER = 0x02
const BOOLEAN = 0x01
const BIT_STRING = 0x03
const OCTET_STRING = 0x04
const OID = 0x06
const UTF8_STRING = 0x0c
const UTC_TIME = 0x17

const ecdsaWithSha256 = der(SEQUENCE, der(OID, Buffer.from([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])))
const commonName = der(
  SEQUENCE,
  der(SET, der(SEQUENCE, der(OID, Buffer.from([0x55, 0x04, 0x03])), der(UTF8_STRING, Buffer.from("localhost"))))
)
const validity = der(
  SEQUENCE,
  der(UTC_TIME, Buffer.from("200101000000Z")),
  der(UTC_TIME, Buffer.from("491231235959Z"))
)
const version3 = der(0xa0, der(INTEGER, Buffer.from([0x02])))
const serial = der(INTEGER, Buffer.from([0x01]))
const extension = (id: ReadonlyArray<number>, critical: boolean, value: Buffer) =>
  der(SEQUENCE, der(OID, Buffer.from(id)), ...(critical ? [der(BOOLEAN, Buffer.from([0xff]))] : []), der(OCTET_STRING, value))

const extensions = der(
  0xa3,
  der(
    SEQUENCE,
    extension([0x55, 0x1d, 0x13], true, der(SEQUENCE, der(BOOLEAN, Buffer.from([0xff])))),
    extension([0x55, 0x1d, 0x11], false, der(SEQUENCE, der(0x82, Buffer.from("localhost"))))
  )
)

const pem = (label: string, body: Uint8Array) => {
  const lines = Buffer.from(body).toString("base64").match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

/**
 * A certificate for `localhost` that signs itself (ECDSA P-256, valid until 2049), with its private
 * key, both PEM. Node's `crypto` cannot issue a certificate, so the X.509 structure is encoded here;
 * a client that lists the certificate as a trusted authority and dials `localhost` accepts it.
 */
export const selfSignedLocalhost = (): { readonly cert: string; readonly key: string } => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const publicKeyInfo = publicKey.export({ type: "spki", format: "der" })
  const toBeSigned = der(
    SEQUENCE,
    version3,
    serial,
    ecdsaWithSha256,
    commonName,
    validity,
    commonName,
    publicKeyInfo,
    extensions
  )
  const signature = sign("sha256", toBeSigned, { key: privateKey, dsaEncoding: "der" })
  const certificate = der(SEQUENCE, toBeSigned, ecdsaWithSha256, der(BIT_STRING, Buffer.from([0x00]), signature))
  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  }
}
