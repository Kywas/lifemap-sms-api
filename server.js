require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const {
  createJob,
  getJob,
  cancelJob,
  getDueJobs,
  markSent,
  markFailed,
  updateJob,
} = require("./db");

const app = express();
const PORT = Number(process.env.PORT) || 8787;
const API_ID = process.env.SMSRU_API_ID;
const SMS_FROM = String(process.env.SMSRU_FROM || "").trim();
const APP_SECRET = process.env.APP_SECRET || "";
const IS_PROD = process.env.NODE_ENV === "production";
const SMSRU_MIN_AHEAD_SEC = 5;

app.use(express.json({ limit: "16kb" }));
app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-App-Secret");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

function checkAuth(req, res) {
  if (IS_PROD && !APP_SECRET) {
    res.status(503).json({ ok: false, error: "APP_SECRET не задан на сервере" });
    return false;
  }
  if (APP_SECRET && req.get("X-App-Secret") !== APP_SECRET) {
    res.status(401).json({ ok: false, error: "Неверный секрет приложения" });
    return false;
  }
  return true;
}

function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  if (!/^7\d{10}$/.test(digits)) return null;
  return digits;
}

async function smsRuRequest(path, params) {
  const payload = { ...params, api_id: API_ID, json: "1" };
  if (SMS_FROM && path === "sms/send") payload.from = SMS_FROM;
  const qs = new URLSearchParams(payload);
  const res = await fetch(`https://sms.ru/${path}?${qs}`);
  return res.json();
}

function getSmsBlock(data, phone) {
  if (!data?.sms || typeof data.sms !== "object") return null;
  if (data.sms[phone]) return data.sms[phone];
  const digits = String(phone).replace(/\D/g, "");
  for (const [key, block] of Object.entries(data.sms)) {
    if (String(key).replace(/\D/g, "") === digits) return block;
  }
  const keys = Object.keys(data.sms);
  return keys.length === 1 ? data.sms[keys[0]] : null;
}

function smsRuError(data, fallback) {
  if (data?.status !== "OK") {
    const code = data?.status_code ? ` (код ${data.status_code})` : "";
    return (data?.status_text || fallback) + code;
  }
  return fallback;
}

function parseSmsRuSendResponse(data, phone, fallback) {
  if (data?.status !== "OK") {
    throw new Error(smsRuError(data, fallback));
  }
  const block = getSmsBlock(data, phone);
  if (!block) {
    throw new Error("SMS.ru не вернул статус для номера");
  }
  if (block.status === "ERROR") {
    const code = block.status_code ? ` (код ${block.status_code})` : "";
    throw new Error((block.status_text || "SMS.ru отклонил номер") + code);
  }
  if (!block.sms_id) {
    throw new Error("Не получен sms_id от SMS.ru");
  }
  return String(block.sms_id);
}

function buildTimerSmsMessage(geo) {
  const base = "Life Map: таймер завершён.";
  const lat = Number(geo?.latitude ?? geo?.lat);
  const lng = Number(geo?.longitude ?? geo?.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `${base} Геолокация: https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
  }
  return `${base} Пожалуйста, свяжитесь со мной.`;
}

async function sendSmsNow(phone, message) {
  const data = await smsRuRequest("sms/send", { to: phone, msg: message });
  return parseSmsRuSendResponse(data, phone, "SMS.ru отклонил отправку");
}

async function scheduleSmsRu(phone, message, endTime) {
  const data = await smsRuRequest("sms/send", {
    to: phone,
    msg: message,
    time: String(Math.floor(endTime / 1000)),
  });
  return parseSmsRuSendResponse(data, phone, "SMS.ru отклонил планирование");
}

async function processDueJobs() {
  if (!API_ID) return;
  const now = Date.now();
  const jobs = getDueJobs(now);
  for (const job of jobs) {
    try {
      await sendSmsNow(job.phone, job.message);
      markSent(job.id);
      console.log("[worker] SMS sent:", job.id, job.phone);
    } catch (err) {
      markFailed(job.id);
      console.error("[worker] SMS failed:", job.id, err.message);
    }
  }
}

setInterval(processDueJobs, 15000);
processDueJobs();

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Life Map SMS API",
    health: "/health",
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Life Map SMS API",
    version: "2.1.0",
    smsConfigured: Boolean(API_ID),
    senderConfigured: Boolean(SMS_FROM),
    production: IS_PROD,
  });
});

app.post("/api/sms/schedule", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!API_ID) {
    return res.status(503).json({ ok: false, error: "SMSRU_API_ID не задан на сервере" });
  }

  const phone = normalizePhone(req.body?.phone);
  const endTime = Number(req.body?.endTime);
  const message =
    String(req.body?.message || "").trim() ||
    buildTimerSmsMessage(req.body);

  if (!phone) {
    return res.status(400).json({ ok: false, error: "Неверный номер телефона" });
  }
  if (!Number.isFinite(endTime) || endTime <= Date.now()) {
    return res.status(400).json({ ok: false, error: "Некорректное время окончания" });
  }

  const jobId = crypto.randomUUID();
  let smsruId = null;
  const mode = "worker";

  try {
    const lat = Number(req.body?.latitude ?? req.body?.lat);
    const lng = Number(req.body?.longitude ?? req.body?.lng);
    createJob({
      id: jobId,
      phone,
      endTime,
      message,
      status: "pending",
      smsruId,
      createdAt: Date.now(),
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
    });

    res.json({
      ok: true,
      jobId,
      smsId: jobId,
      scheduledFor: endTime,
      phone,
      mode,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message || "Ошибка планирования" });
  }
});

app.post("/api/sms/cancel", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const jobId = String(req.body?.smsId || req.body?.jobId || "").trim();
  if (!jobId) {
    return res.status(400).json({ ok: false, error: "jobId обязателен" });
  }

  const job = getJob(jobId);
  if (!job) {
    return res.json({ ok: true, note: "Задача не найдена или уже обработана" });
  }

  if (job.status !== "pending") {
    return res.json({ ok: true, note: "Уже " + job.status });
  }

  cancelJob(jobId);

  if (job.smsru_id && API_ID) {
    try {
      await smsRuRequest("sms/stop", { id: job.smsru_id });
    } catch (err) {
      console.error("[cancel] sms.ru stop failed:", err.message);
    }
  }

  res.json({ ok: true });
});

app.post("/api/sms/update", (req, res) => {
  if (!checkAuth(req, res)) return;

  const jobId = String(req.body?.smsId || req.body?.jobId || "").trim();
  if (!jobId) {
    return res.status(400).json({ ok: false, error: "jobId обязателен" });
  }

  const job = getJob(jobId);
  if (!job || job.status !== "pending") {
    return res.status(404).json({ ok: false, error: "Задача не найдена или уже обработана" });
  }

  const latitude = Number(req.body?.latitude ?? req.body?.lat);
  const longitude = Number(req.body?.longitude ?? req.body?.lng);
  const geo = {
    latitude: Number.isFinite(latitude) ? latitude : job.latitude,
    longitude: Number.isFinite(longitude) ? longitude : job.longitude,
  };
  const message = String(req.body?.message || "").trim() || buildTimerSmsMessage(geo);

  if (!updateJob(jobId, {
    message,
    latitude: geo.latitude,
    longitude: geo.longitude,
  })) {
    return res.status(404).json({ ok: false, error: "Не удалось обновить задачу" });
  }

  res.json({ ok: true, message });
});

app.post("/api/sms/test", async (req, res) => {
  if (!checkAuth(req, res)) return;
  if (!API_ID) {
    return res.status(503).json({ ok: false, error: "SMSRU_API_ID не задан" });
  }

  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ ok: false, error: "Неверный номер" });
  }

  try {
    const smsId = await sendSmsNow(
      phone,
      "Life Map: тестовое SMS. Если вы его получили — глобальный сервер работает."
    );
    res.json({ ok: true, smsId, phone });
  } catch (err) {
    console.error("[test]", phone, err.message);
    res.status(502).json({ ok: false, error: err.message || "Ошибка SMS.ru" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("  Life Map SMS API v2");
  console.log("  Port:", PORT);
  console.log("  Mode:", IS_PROD ? "production" : "development");
  console.log("  SMS.ru:", API_ID ? "ok" : "NOT CONFIGURED");
  console.log("  Auth:", APP_SECRET ? "secret required" : IS_PROD ? "MISSING SECRET" : "open (dev)");
  console.log("");
});
