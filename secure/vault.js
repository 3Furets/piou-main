import fs from "fs";
import path from "path";
import crypto from "crypto";

const ALGO = "aes-256-gcm";

function getKey() {
  const secret = process.env.PIOU_VAULT_KEY || "piou-dev-key-change-me-32chars!!";
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(text) {
  const iv  = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(payload) {
  const buf  = Buffer.from(payload, "base64");
  const iv   = buf.subarray(0, 12);
  const tag  = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key  = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export async function loadEnv(file = ".env") {
  try {
    if (!fs.existsSync(file)) return {};
    const obj = {};
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i === -1) continue;
      obj[t.slice(0,i).trim()] = t.slice(i+1).trim();
    }
    return obj;
  } catch { return {}; }
}

export async function writeEnc(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const raw = typeof data === "string" ? data : String(data);
  const out = filePath.endsWith(".enc") ? encrypt(raw) : raw;
  fs.writeFileSync(filePath, out, "utf8");
}

export async function writeJSONEnc(filePath, data) {
  await writeEnc(filePath, JSON.stringify(data, null, 2));
}

export async function readJSONEnc(filePath) {
  if (!fs.existsSync(filePath)) throw new Error("Fichier introuvable: " + filePath);
  let raw = fs.readFileSync(filePath, "utf8");
  if (filePath.endsWith(".enc")) {
    try { raw = decrypt(raw); } catch {}
  }
  return JSON.parse(raw);
}