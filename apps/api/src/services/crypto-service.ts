import crypto from "node:crypto";
import { config } from "../config.js";

const key = crypto
  .createHash("sha256")
  .update(config.ENCRYPTION_KEY)
  .digest();

export interface EncryptedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptSecret(value: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: EncryptedSecret = {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

export function decryptSecret(payload: string): string {
  const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as EncryptedSecret;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(parsed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
