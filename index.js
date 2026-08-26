/* =====================================================================
   LaundryPay — QR payment scanner
   -------------------------------------------------------------
   Scans a QR code with the phone/PC camera (jsQR). When the scanned
   code is the integer `expectedValue` (default 5), it publishes the
   command `command` ('1') to the EMQX MQTT topic. The ESP32 listens
   on that topic and executes the machine command.

   Transport: MQTT over WebSocket (WSS, port 8084) — EMQX Cloud's
   browser-friendly endpoint. (The EMQX REST API on :8443 also accepts
   the publish but sends no CORS headers, so browsers can't call it.)
   ===================================================================== */

/* ---------------- CONFIG (from dummy-qr-scanner snippet) ---------------- */
const CONFIG = {
  emqxApi: "https://z181062f.ala.us-east-1.emqxsl.com:8443/api/v5",
  appId: "hf6a61db",
  appSecret: "Z!IdAIjFN*dY0B.Y",
  mqttHost: "wss://z181062f.ala.us-east-1.emqxsl.com:8084/mqtt", // EMQX Cloud MQTT-over-WSS
  mqttUser: "dobi-mjii",
  mqttPass: "dobi-mjii",
  topic: "testtopic/mjii_dobi",
  expectedValue: 5, // QR code value that counts as a valid payment
  command: "1",     // MQTT payload sent to the ESP32 ('1' or 'ok')
};

/* ---------------- State ---------------- */
const state = {
  cameraOn: false,
  scanning: false,
  stream: null,
  lastDecodeAt: 0,
};

/* ---------------- DOM shortcuts ---------------- */
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const logEl = $("log");

/* ================= MQTT (mqtt.js) ================= */
let mqttClient = null;

function setConnPill(cls, text) {
  $("conn-pill").className = "pill " + cls;
  $("conn-text").textContent = text;
}

function connectMqtt() {
  if (typeof mqtt === "undefined") {
    setConnPill("pill-error", "mqtt.js missing");
    log("mqtt.js library not loaded — check vendor/mqtt.min.js", "error");
    return;
  }
  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }

  const clientId =
    "laundrypay_" +
    Date.now().toString(16) +
    "_" +
    Math.random().toString(16).slice(2, 6);

  mqttClient = mqtt.connect(CONFIG.mqttHost, {
    clientId: clientId,
    username: CONFIG.mqttUser,
    password: CONFIG.mqttPass,
    clean: true,
    connectTimeout: 10000,
    reconnectPeriod: 3000,
    keepalive: 60,
  });

  mqttClient.on("connect", () => {
    setConnPill("pill-ok", "connected");
    log("MQTT connected → " + CONFIG.mqttHost, "success");
    mqttClient.subscribe(CONFIG.topic, { qos: 1 });
  });

  mqttClient.on("reconnect", () => setConnPill("pill-warn", "reconnecting"));
  mqttClient.on("close", () => setConnPill("pill-offline", "offline"));
  mqttClient.on("error", (err) => {
    setConnPill("pill-error", "error");
    log("MQTT error: " + err.message, "error");
  });
  mqttClient.on("message", (topic, payload) => {
    log("RX " + topic + ": " + payload.toString(), "info");
  });
}

function publishCommand(cmd) {
  if (!mqttClient || !mqttClient.connected) {
    log("Not connected to MQTT — command NOT sent", "error");
    return false;
  }
  mqttClient.publish(CONFIG.topic, cmd, { qos: 1 }, (err) => {
    if (err) {
      log("Publish failed: " + err.message, "error");
    } else {
      log('Published "' + cmd + '" → ' + CONFIG.topic, "success");
    }
  });
  return true;
}

/* ================= QR handling ================= */
function parseCodeValue(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Tolerate common currency prefixes, e.g. "RM5", "MYR 5", "$5"
  s = s.replace(
    /^(RM|MYR|\$|USD|usd|₱|PHP|php|฿|THB|thb|Rp|IDR|idr|€|EUR|eur|£|GBP|gbp|¥|￥)\s*/i,
    ""
  );
  if (!/^[+-]?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

function handleScan(raw) {
  const now = Date.now();
  if (now - state.lastDecodeAt < 1500) return; // debounce repeated reads
  state.lastDecodeAt = now;

  const value = parseCodeValue(raw);
  if (value === null) {
    setPayment("warn", "⚠️", "Not a payment code", 'Scanned: "' + String(raw).slice(0, 40) + '"');
    log('Ignored non-numeric QR: "' + String(raw).slice(0, 40) + '"', "warn");
    return;
  }

  if (value === CONFIG.expectedValue) {
    setPayment(
      "ok",
      "✅",
      "Payment confirmed!",
      'Sending "' + CONFIG.command + '" to ' + CONFIG.topic
    );
    log('Valid QR value ' + value + ' → sending "' + CONFIG.command + '"', "success");
    publishCommand(CONFIG.command);
  } else {
    setPayment(
      "err",
      "❌",
      "Invalid code",
      "Expected " + CONFIG.expectedValue + ", got " + value
    );
    log("Invalid QR value " + value + " (expected " + CONFIG.expectedValue + ")", "error");
  }
}

function setPayment(state_, icon, title, sub) {
  $("pay-card").className = "card pay-card pay-" + state_;
  $("pay-icon").textContent = icon;
  $("pay-title").textContent = title;
  $("pay-sub").textContent = sub;
  if (state_ !== "wait") beep(state_ === "ok");
}


/* ================= Camera + jsQR loop ================= */
async function startCamera() {
  $("cam-err").hidden = true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCamError("Camera API not available — are you on http://localhost or https?");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    await video.play();
    state.cameraOn = true;
    state.scanning = true;
    $("cam-idle").style.display = "none";
    $("btn-cam").textContent = "■ Stop Camera";
    log("Camera started");
    requestAnimationFrame(tick);
  } catch (err) {
    showCamError(
      "Camera error: " + err.message + " — use 'Simulate' or the manual input instead."
    );
    log("Camera error: " + err.message, "error");
  }
}

function showCamError(msg) {
  const el = $("cam-err");
  el.hidden = false;
  el.textContent = msg;
}

function stopCamera() {
  state.scanning = false;
  state.cameraOn = false;
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  $("cam-idle").style.display = "flex";
  $("btn-cam").textContent = "▶ Start Camera";
}

function tick() {
  if (!state.scanning) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (code && code.data) handleScan(code.data);
    } catch (e) {
      /* ignore frame errors */
    }
  }
  requestAnimationFrame(tick);
}

/* ================= Utilities ================= */
function log(msg, cls) {
  const li = document.createElement("li");
  li.textContent = "[" + new Date().toLocaleTimeString() + "] " + msg;
  if (cls) li.className = cls;
  logEl.prepend(li);
  while (logEl.children.length > 30) logEl.lastChild.remove();
}

let audioCtx = null;
function beep(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = ok ? "sine" : "square";
    osc.frequency.value = ok ? 880 : 220;
    const t = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + (ok ? 0.25 : 0.4));
    osc.start(t);
    osc.stop(t + (ok ? 0.25 : 0.4));
  } catch (e) {
    /* audio unavailable */
  }
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderConfig() {
  const cfg = [
    ["MQTT host", CONFIG.mqttHost],
    ["Username", CONFIG.mqttUser],
    ["Password", CONFIG.mqttPass.replace(/./g, "•")],
    ["Topic", CONFIG.topic],
    ["Expected QR value", CONFIG.expectedValue],
    ["Command payload", CONFIG.command],
    ["EMQX REST API", CONFIG.emqxApi],
    ["App id", CONFIG.appId],
    ["App secret", CONFIG.appSecret],
  ];
  $("cfg-view").innerHTML =
    "<table>" +
    cfg.map(([k, v]) => "<tr><td>" + esc(k) + "</td><td>" + esc(v) + "</td></tr>").join("") +
    "</table>";
}

/* ================= Events ================= */
$("btn-cam").addEventListener("click", () => {
  state.cameraOn ? stopCamera() : startCamera();
});
$("btn-sim").addEventListener("click", () => {
  handleScan(String(CONFIG.expectedValue));
});
$("btn-manual").addEventListener("click", () => {
  const v = $("manual-code").value.trim();
  if (v) handleScan(v);
});
$("manual-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-manual").click();
});

/* ================= Init ================= */
renderConfig();
connectMqtt();
setPayment("wait", "🔍", "Waiting for QR code", "Scan the QR code on the machine");

