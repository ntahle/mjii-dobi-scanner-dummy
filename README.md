# LaundryPay — QR Payment Scanner (web app)

Phone/PC web app that scans a QR code and triggers an ESP32 machine via MQTT.

**Behavior**
- Scan a QR code with the camera (or click **Simulate "5"** / type the code manually).
- If the code is the integer **5** → publishes `1` to MQTT topic `testtopic/mjii_dobi`.
- The ESP32 (`qr-payment-laundry` firmware) subscribes to that topic and pulses
  `ACTION_PIN` (GPIO 2) when it receives `1` or `ok`.

## How to run

The camera requires a secure context, so serve the folder over `localhost`/HTTPS:

```bash
cd dummy-qr-scanner
python -m http.server 8000
# open http://localhost:8000 in Chrome/Edge (phone too: http://<PC-IP>:8000)
```

If you are on a phone, keep the page served on the PC's LAN IP — but
`getUserMedia` only works on `localhost` or `https`. Use `ngrok`/tunneling for a
LAN/phone test, or simply use the **Simulate** button / manual input for the demo.

## MQTT details

| Field | Value |
|---|---|
| Broker (WSS) | `wss://z181062f.ala.us-east-1.emqxsl.com:8084/mqtt` |
| Username / password | `dobi-mjii` / `dobi-mjii` |
| Topic | `testtopic/mjii_dobi` |
| QR value that triggers payment | `5` |
| MQTT payload sent | `1` |

> Why WSS and not the REST API? The EMQX REST API (`https://…:8443/api/v5`) works
> and accepts publishes, but it does **not** send CORS headers, so a browser page
> cannot call it. MQTT over WebSocket (port 8084) is reachable from any origin.

## Files

- `index.html` — page layout
- `index.css` — styles
- `index.js` — config + QR logic + MQTT (edit `CONFIG` at the top)
- `vendor/jsqr.js` — QR decode library
- `vendor/mqtt.min.js` — MQTT over WebSocket client
