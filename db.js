const fs = require("fs");
const path = require("path");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const filePath = path.join(dataDir, "jobs.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function load() {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data.jobs) ? data : { jobs: [] };
  } catch {
    return { jobs: [] };
  }
}

function save(data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function createJob(row) {
  const data = load();
  data.jobs.push({
    id: row.id,
    phone: row.phone,
    end_time: row.endTime,
    message: row.message,
    status: row.status || "pending",
    smsru_id: row.smsruId || null,
    created_at: row.createdAt,
    sent_at: null,
  });
  save(data);
  return row.id;
}

function getJob(id) {
  return load().jobs.find((j) => j.id === id) || null;
}

function cancelJob(id) {
  const data = load();
  const job = data.jobs.find((j) => j.id === id && j.status === "pending");
  if (!job) return false;
  job.status = "cancelled";
  save(data);
  return true;
}

function getDueJobs(now) {
  return load().jobs.filter(
    (j) => j.status === "pending" && !j.smsru_id && j.end_time <= now
  );
}

function markSent(id) {
  const data = load();
  const job = data.jobs.find((j) => j.id === id);
  if (!job) return;
  job.status = "sent";
  job.sent_at = Date.now();
  save(data);
}

function markFailed(id) {
  const data = load();
  const job = data.jobs.find((j) => j.id === id);
  if (!job) return;
  job.status = "failed";
  save(data);
}

module.exports = {
  createJob,
  getJob,
  cancelJob,
  getDueJobs,
  markSent,
  markFailed,
};
