/**
 * 企业微信回调消息加解密（WXBizMsgCrypt 的 Node 实现，只用 node:crypto）
 *
 * 规范要点（容易写错的地方都标了）：
 *   1. AESKey = base64_decode(EncodingAESKey + "=")，固定 32 字节；IV 取前 16 字节
 *   2. 签名 = sha1( 把 token、timestamp、nonce、密文 按字典序排序后拼接 )
 *   3. 明文结构 = 16字节随机数 + 4字节网络序消息长度 + 消息体 + receiveid
 *   4. 补位用 PKCS7，但 **块大小是 32 字节不是 16**，所以这里手动补位后走 NoPadding
 */

import crypto from "node:crypto";

const BLOCK_SIZE = 32;

export function decodeAesKey(encodingAesKey) {
  if (!encodingAesKey || encodingAesKey.length !== 43) {
    throw new Error(`EncodingAESKey 长度应为 43，实际 ${encodingAesKey?.length ?? 0}`);
  }
  const key = Buffer.from(encodingAesKey + "=", "base64");
  if (key.length !== 32) throw new Error(`AESKey 应为 32 字节，实际 ${key.length}`);
  return key;
}

/** 企业微信/微信的签名算法 */
export function signature(token, timestamp, nonce, encrypted) {
  const raw = [token, timestamp, nonce, encrypted].sort().join("");
  return crypto.createHash("sha1").update(raw, "utf8").digest("hex");
}

export function verifySignature({ token, timestamp, nonce, encrypted, msgSignature }) {
  if (!msgSignature) return false;
  const expected = signature(token, String(timestamp), String(nonce), encrypted);
  // 定长比较，避免时序侧信道
  const a = Buffer.from(expected);
  const b = Buffer.from(String(msgSignature).toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function pkcs7Pad(buf) {
  const padLen = BLOCK_SIZE - (buf.length % BLOCK_SIZE) || BLOCK_SIZE;
  return Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
}

function pkcs7Unpad(buf) {
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > BLOCK_SIZE) return buf; // 补位异常就不处理，交给上层校验
  return buf.subarray(0, buf.length - pad);
}

/** 解密回调密文，返回 { message, receiveId } */
export function decrypt(encodingAesKey, encryptedBase64) {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = pkcs7Unpad(
    Buffer.concat([decipher.update(Buffer.from(encryptedBase64, "base64")), decipher.final()])
  );
  if (plain.length < 20) throw new Error("解密结果长度异常");

  const msgLen = plain.readUInt32BE(16);
  const message = plain.subarray(20, 20 + msgLen).toString("utf8");
  const receiveId = plain.subarray(20 + msgLen).toString("utf8");
  return { message, receiveId };
}

/** 加密（被动回复用；本项目主要走主动推送，这里留着备用） */
export function encrypt(encodingAesKey, message, receiveId = "") {
  const key = decodeAesKey(encodingAesKey);
  const iv = key.subarray(0, 16);
  const random16 = crypto.randomBytes(16);
  const msgBuf = Buffer.from(message, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const raw = pkcs7Pad(Buffer.concat([random16, lenBuf, msgBuf, Buffer.from(receiveId, "utf8")]));
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(raw), cipher.final()]).toString("base64");
}

/* ------------------------------ 极简 XML ------------------------------ */

/** 取出 <Tag><![CDATA[...]]></Tag> 或 <Tag>...</Tag> 的值 */
export function xmlField(xml, tag) {
  const cdata = new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i");
  const plain = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`, "i");
  return (xml.match(cdata)?.[1] ?? xml.match(plain)?.[1] ?? "").trim();
}

/** 转义成 CDATA 安全文本 */
export function cdata(s) {
  return `<![CDATA[${String(s).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

/* ------------------------------ 自测 ------------------------------ */

export function selfTest() {
  const aesKey = crypto.randomBytes(32).toString("base64").replace(/=+$/, "");
  const msg = "<xml><Content><![CDATA[今天写什么？测试 & <符号>]]></Content></xml>";
  const enc = encrypt(aesKey, msg, "ww1234567890");
  const { message, receiveId } = decrypt(aesKey, enc);
  const ok = message === msg && receiveId === "ww1234567890";
  const sig = signature("tok", "1700000000", "nonce", enc);
  const sigOk = verifySignature({
    token: "tok",
    timestamp: "1700000000",
    nonce: "nonce",
    encrypted: enc,
    msgSignature: sig,
  });
  const badSig = verifySignature({
    token: "tok",
    timestamp: "1700000000",
    nonce: "nonce",
    encrypted: enc,
    msgSignature: "deadbeef",
  });
  return { ok, sigOk, badSigRejected: !badSig, roundTrip: message };
}
