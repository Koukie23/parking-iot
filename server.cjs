const express = require("express");
const path = require("node:path");
const app = express();
const PORT = process.env.PORT || 3000;
const DEVICE_API_KEY = process.env.DEVICE_API_KEY;
const DEVICE_TIMEOUT_MS = 10_000;
const lastHardwareSeen = new Map();
const bays = ["P1", "P2"].map(bay_id => ({
  bay_id, distance_cm: null, occupancy: "unknown",
  brightness_pct: null, mode: "auto"
}));

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

function requireDeviceKey(req, res, next) {
  if (!DEVICE_API_KEY) {
    return res.status(503).json({ error: "Device API key is not configured" });
  }
  if (req.get("X-Device-Key") !== DEVICE_API_KEY) {
    return res.status(401).json({ error: "Invalid device key" });
  }
  next();
}

app.get("/api/parking", (req, res) => {
  res.set("Cache-Control", "no-store");
  const now = Date.now();
  const result = bays.map(bay => {
    const seen = lastHardwareSeen.get(bay.bay_id);
    const online = seen !== undefined && now - seen < DEVICE_TIMEOUT_MS;
    return {
      ...bay, data_source: "hardware", online,
      last_seen: seen === undefined ? null : new Date(seen).toISOString(),
      occupancy: online ? bay.occupancy : "unknown",
      distance_cm: online ? bay.distance_cm : null,
      brightness_pct: online ? bay.brightness_pct : null
    };
  });
  res.json({ data_source: "hardware", total: result.length,
    available: result.filter(bay => bay.occupancy === "free").length,
    bays: result });
});

// Both bays now use hardware. Simulation must not overwrite them.
app.post("/api/simulation/occupancy", (req, res) => {
  res.status(403).json({ error: "P1、P2 均已改为真实硬件，模拟接口已停用" });
});

app.post("/api/device/state", requireDeviceKey, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  // Accept a complete two-bay batch, or a legacy single-bay report.
  const batch = Object.hasOwn(body, "bays");
  const updates = batch ? body.bays : [body];
  if (!Array.isArray(updates) || (batch && updates.length !== 2)) {
    return res.status(400).json({ error: "Expected exactly two bays" });
  }
  const ids = new Set();
  for (const item of updates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return res.status(400).json({ error: "Invalid bay data" });
    }
    const validDistance = item.distance_cm === null ||
      (Number.isFinite(item.distance_cm) && item.distance_cm >= 2 && item.distance_cm <= 200);
    if (!bays.some(bay => bay.bay_id === item.bay_id) || ids.has(item.bay_id) ||
        !validDistance || !["free", "occupied", "unknown"].includes(item.occupancy) ||
        ![100, 40].includes(item.brightness_pct)) {
      return res.status(400).json({ error: "Invalid bay data" });
    }
    ids.add(item.bay_id);
  }
  // Validate the entire batch before applying either update.
  const now = Date.now();
  for (const item of updates) {
    const bay = bays.find(bay => bay.bay_id === item.bay_id);
    Object.assign(bay, { distance_cm: item.distance_cm,
      occupancy: item.occupancy, brightness_pct: item.brightness_pct });
    lastHardwareSeen.set(item.bay_id, now);
  }
  res.json({ ok: true, updated: [...ids] });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Two-bay parking server listening on port ${PORT}`);
});
