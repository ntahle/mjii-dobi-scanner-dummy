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

/* ---------------- Scan & Pay views ---------------- */
const VIEWS = ["idle", "scanning", "confirm", "invalid", "success"];

function showState(name) {
  VIEWS.forEach((v) => {
    $("view-" + v).hidden = v !== name;
  });
  // The camera is only visible while actually scanning
  $("scanner-card").style.display = name === "scanning" ? "" : "none";
}

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
  if (value === CONFIG.expectedValue) {
    // Valid payment QR -> show confirmation
    stopCamera();
    state.pendingValue = value;
    $("confirm-value").textContent = "RM " + value.toFixed(2);
    showState("confirm");
    beep(true);
    log("Valid QR value " + value + " — awaiting confirmation");
  } else {
    // Anything else -> invalid QR
    stopCamera();
    $("invalid-text").textContent = "Invalid QR code";
    $("invalid-sub").textContent = "Please scan the QR code on the machine";
    showState("invalid");
    beep(false);
    log('Invalid QR: "' + String(raw).slice(0, 40) + '"', "warn");
  }
}

function confirmPayment() {
  if (publishCommand(CONFIG.command)) {
    showState("success");
    log('Payment sent: "' + CONFIG.command + '" → ' + CONFIG.topic, "success");
    setTimeout(() => showState("idle"), 2500);
  } else {
    $("invalid-text").textContent = "Payment failed";
    $("invalid-sub").textContent = "Not connected to MQTT — check the connection";
    showState("invalid");
  }
}


/* ================= Camera + jsQR loop ================= */
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $("invalid-text").textContent = "Camera unavailable";
    $("invalid-sub").textContent = "No camera found — open this page on http://localhost or https.";
    showState("invalid");
    log("Camera API not available", "error");
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
    $("live-badge").classList.add("on");
    $("live-text").textContent = "Live";
    showState("scanning");
    log("Camera started");
    requestAnimationFrame(tick);
  } catch (err) {
    $("invalid-text").textContent = "Camera error";
    $("invalid-sub").textContent = err.message + " — allow camera access and try again.";
    showState("invalid");
    log("Camera error: " + err.message, "error");
  }
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
  $("live-badge").classList.remove("on");
  $("live-text").textContent = "Standby";
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
  const line = "[" + new Date().toLocaleTimeString() + "] " + msg;
  if (cls === "error") console.error(line);
  else if (cls === "warn") console.warn(line);
  else console.log(line);
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

/* ================= Events ================= */
$("btn-pay").addEventListener("click", () => {
  state.cameraOn ? stopCamera() : startCamera();
});
$("btn-stop").addEventListener("click", () => {
  stopCamera();
  showState("idle");
});
$("btn-confirm-pay").addEventListener("click", confirmPayment);
$("btn-confirm-cancel").addEventListener("click", () => {
  showState("idle");
});
$("btn-retry").addEventListener("click", () => {
  startCamera();
});

/* ================= Init ================= */
showState("idle");
connectMqtt();

