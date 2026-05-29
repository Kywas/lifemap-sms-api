const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const filePath = path.join(dataDir, "auth.json");

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function load() {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      users: Array.isArray(data.users) ? data.users : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      otps: Array.isArray(data.otps) ? data.otps : [],
    };
  } catch {
    return { users: [], sessions: [], otps: [] };
  }
}

function save(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function cleanup(data) {
  const now = Date.now();
  data.otps = data.otps.filter((item) => item.expires_at > now);
  data.sessions = data.sessions.filter((item) => item.expires_at > now);
  return data;
}

function formatPhoneDisplay(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length !== 11 || !digits.startsWith("7")) return phone || "";
  return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
}

function buildSenderPrefix(phone, name) {
  if (!phone) return "";
  const label = String(name || "").trim()
    ? `${String(name).trim()} (${formatPhoneDisplay(phone)})`
    : formatPhoneDisplay(phone);
  return `Life Map · ${label}: `;
}

function applySenderPrefix(message, phone, name) {
  const text = String(message || "").trim();
  if (!phone || !text) return text;
  const prefix = buildSenderPrefix(phone, name);
  if (text.startsWith("Life Map ·")) return text;
  return `${prefix}${text}`.slice(0, 320);
}

function getUser(phone) {
  const data = cleanup(load());
  return data.users.find((user) => user.phone === phone) || null;
}

function upsertUser(phone, name) {
  const data = cleanup(load());
  let user = data.users.find((item) => item.phone === phone);
  if (!user) {
    user = { phone, name: String(name || "").trim(), created_at: Date.now() };
    data.users.push(user);
  } else if (String(name || "").trim()) {
    user.name = String(name).trim();
    user.updated_at = Date.now();
  }
  save(data);
  return user;
}

function canSendCode(phone) {
  const data = cleanup(load());
  const last = data.otps
    .filter((item) => item.phone === phone)
    .sort((a, b) => b.sent_at - a.sent_at)[0];
  if (!last) return { ok: true };
  const waitMs = OTP_RESEND_MS - (Date.now() - last.sent_at);
  if (waitMs > 0) {
    return { ok: false, waitSec: Math.ceil(waitMs / 1000) };
  }
  return { ok: true };
}

function createOtp(phone, code) {
  const data = cleanup(load());
  data.otps = data.otps.filter((item) => item.phone !== phone);
  data.otps.push({
    phone,
    code,
    attempts: 0,
    sent_at: Date.now(),
    expires_at: Date.now() + OTP_TTL_MS,
  });
  save(data);
}

function verifyOtp(phone, code) {
  const data = cleanup(load());
  const otp = data.otps.find((item) => item.phone === phone);
  if (!otp) return { ok: false, error: "Код не найден. Запросите новый." };
  if (otp.expires_at <= Date.now()) {
    data.otps = data.otps.filter((item) => item.phone !== phone);
    save(data);
    return { ok: false, error: "Код истёк. Запросите новый." };
  }
  if (otp.attempts >= MAX_VERIFY_ATTEMPTS) {
    return { ok: false, error: "Слишком много попыток. Запросите новый код." };
  }
  if (String(code).trim() !== String(otp.code)) {
    otp.attempts += 1;
    save(data);
    return { ok: false, error: "Неверный код" };
  }
  data.otps = data.otps.filter((item) => item.phone !== phone);
  save(data);
  return { ok: true };
}

function createSession(phone) {
  const data = cleanup(load());
  const token = crypto.randomBytes(32).toString("hex");
  data.sessions.push({
    token,
    phone,
    created_at: Date.now(),
    expires_at: Date.now() + SESSION_TTL_MS,
  });
  save(data);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const data = cleanup(load());
  const session = data.sessions.find((item) => item.token === token);
  if (!session || session.expires_at <= Date.now()) return null;
  const user = getUser(session.phone);
  return {
    phone: session.phone,
    name: user?.name || "",
    token: session.token,
  };
}

function deleteSession(token) {
  const data = cleanup(load());
  data.sessions = data.sessions.filter((item) => item.token !== token);
  save(data);
}

function updateUserName(phone, name) {
  const data = cleanup(load());
  const user = data.users.find((item) => item.phone === phone);
  if (!user) return null;
  user.name = String(name || "").trim();
  user.updated_at = Date.now();
  save(data);
  return user;
}

module.exports = {
  OTP_TTL_MS,
  formatPhoneDisplay,
  buildSenderPrefix,
  applySenderPrefix,
  canSendCode,
  createOtp,
  verifyOtp,
  createSession,
  getSession,
  deleteSession,
  upsertUser,
  updateUserName,
  getUser,
};
