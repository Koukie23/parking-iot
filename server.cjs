const express = require("express");
const path = require("node:path");

const app = express();
const PORT = process.env.PORT || 3000;

// 解析网页发送的JSON。
app.use(express.json({ limit: "10kb" }));

// 提供网页。
app.use(express.static(path.join(__dirname, "public")));

const bays = [
  {
    bay_id: "P1",
    distance_cm: 30,
    occupancy: "free",
    brightness_pct: 100,
    mode: "auto",
  },
  {
    bay_id: "P2",
    distance_cm: 8,
    occupancy: "occupied",
    brightness_pct: 40,
    mode: "auto",
  },
  {
    bay_id: "P3",
    distance_cm: 30,
    occupancy: "free",
    brightness_pct: 100,
    mode: "auto",
  },
];

const lastHardwareSeen = new Map();
const DEVICE_TIMEOUT_MS = 10_000;

// 每个车位独立管理调暗计时器。
const dimTimers = new Map();
const PARK_DELAY_MS = 5000;

// 查询车位状态。
app.get("/api/parking", (req, res) => {
  res.set("Cache-Control", "no-store");

  const now = Date.now();

  const result = bays.map(bay => {
    // 目前只有 P1 接入硬件，P2、P3 仍为模拟数据
    const isHardware = bay.bay_id === "P1";

    if (!isHardware) {
      return {
        ...bay,
        data_source: "simulation",
        online: null,
        last_seen: null
      };
    }

    const lastSeen = lastHardwareSeen.get(bay.bay_id);

    const online =
      lastSeen !== undefined &&
      now - lastSeen < DEVICE_TIMEOUT_MS;

    return {
      ...bay,
      data_source: "hardware",
      online,
      last_seen:
        lastSeen === undefined
          ? null
          : new Date(lastSeen).toISOString(),

      // 离线后不再把旧数据当成实时结果
      occupancy: online ? bay.occupancy : "unknown",
      distance_cm: online ? bay.distance_cm : null,
      brightness_pct: online ? bay.brightness_pct : null
    };
  });

  res.json({
    data_source: "mixed",
    total: result.length,
    available: result.filter(
      bay => bay.occupancy === "free"
    ).length,
    bays: result
  });
});

// 本地开发用：模拟车辆进入或离开。
app.post("/api/simulation/occupancy", (req, res) => {
  const { bay_id, occupancy } = req.body || {};

  const bay = bays.find(item => item.bay_id === bay_id);

  if (!bay) {
    return res.status(400).json({
      error: "车位编号必须是P1、P2或P3",
    });
  }

  if (!["free", "occupied"].includes(occupancy)) {
    return res.status(400).json({
      error: "occupancy必须是free或occupied",
    });
  }

  // 重复点击相同状态，不重新开始计时。
  if (bay.occupancy === occupancy) {
    return res.json({
      message: "车位已经处于该状态",
      bay,
    });
  }

  // 车辆提前离开时，取消尚未完成的调暗任务。
  clearTimeout(dimTimers.get(bay_id));
  dimTimers.delete(bay_id);

  bay.occupancy = occupancy;
  bay.distance_cm = occupancy === "occupied" ? 8 : 30;
  bay.brightness_pct = 100;

  if (occupancy === "occupied") {
    const timer = setTimeout(() => {
      if (bay.occupancy === "occupied") {
        bay.brightness_pct = 40;
      }

      dimTimers.delete(bay_id);
      console.log(`${bay_id}: 灯光降至40%`);
    }, PARK_DELAY_MS);

    dimTimers.set(bay_id, timer);
  }

  console.log(`${bay_id}: ${occupancy}`);

  res.json({
    message: occupancy === "occupied"
      ? `${bay_id}车辆进入，5秒后调暗`
      : `${bay_id}车辆离开，恢复全亮`,
    bay,
  });
});

// 接收硬件上传的车位状态
app.post("/api/device/state", (req, res) => {
  const {
    bay_id,
    distance_cm,
    occupancy,
    brightness_pct
  } = req.body ?? {};

  const bay = bays.find(item => item.bay_id === bay_id);

  if (!bay) {
    return res.status(400).json({ error: "Unknown bay_id" });
  }

  const validDistance =
    distance_cm === null ||
    (typeof distance_cm === "number" &&
      Number.isFinite(distance_cm) &&
      distance_cm >= 0);

  if (
    !validDistance ||
    !["free", "occupied", "unknown"].includes(occupancy) ||
    ![100, 40].includes(brightness_pct)
  ) {
    return res.status(400).json({ error: "Invalid state data" });
  }

  Object.assign(bay, {
    distance_cm,
    occupancy,
    brightness_pct
  });
  
  lastHardwareSeen.set(bay_id, Date.now());

  console.log("Hardware update:", bay);

  res.json({ ok: true, bay });
});

// 本阶段仅监听本机，模拟接口暂不发布公网。
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});