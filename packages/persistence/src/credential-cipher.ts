import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const payloadVersion = 1;
const nonceLength = 12;
const authenticationTagLength = 16;

export class CredentialCipher {
  private readonly key: Buffer;

  public constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== base64Key) {
      throw new Error("Credential encryption key must be a base64-encoded 32-byte key");
    }
  }

  public encrypt(value: string, context: string): Uint8Array<ArrayBuffer> {
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    return new Uint8Array(
      Buffer.concat([Buffer.from([payloadVersion]), nonce, authenticationTag, ciphertext]),
    );
  }

  public decrypt(payload: Uint8Array<ArrayBufferLike>, context: string): string {
    const buffer = Buffer.from(payload);
    if (
      buffer.length <= 1 + nonceLength + authenticationTagLength ||
      buffer[0] !== payloadVersion
    ) {
      throw new Error("Unsupported or invalid encrypted credential payload");
    }
    const nonceStart = 1;
    const tagStart = nonceStart + nonceLength;
    const ciphertextStart = tagStart + authenticationTagLength;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      buffer.subarray(nonceStart, tagStart),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(buffer.subarray(tagStart, ciphertextStart));
    return Buffer.concat([
      decipher.update(buffer.subarray(ciphertextStart)),
      decipher.final(),
    ]).toString("utf8");
  }
}

export function exchangeCredentialContext(input: {
  workspaceId: string;
  exchange: string;
  environment: string;
  label: string;
}) {
  return JSON.stringify([
    "exchange-credentials",
    input.workspaceId,
    input.exchange,
    input.environment,
    input.label,
  ]);
}
