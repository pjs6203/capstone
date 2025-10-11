# ESP32 <-> PC BLE Test

Quick demo to verify BLE communication between an ESP32 (acting as a BLE GATT server) and a PC Python script using `bleak`.

## Overview
- ESP32 advertises a custom service UUID: `12345678-1234-1234-1234-1234567890ab`.
- Notifiable characteristic (`...90ac`) sends a counter every second and also sends responses to commands.
- Writable characteristic (`...90ad`) accepts UTF-8 commands from the Python client.
- Python client scans, connects, subscribes to notifications, and writes a test command.

## Files
- `esp32_ble_server.ino` : Arduino sketch for ESP32 BLE server.
- `python_ble_client.py` : Python async client using `bleak`.

## ESP32 Setup
1. Open `esp32_ble_server.ino` in Arduino IDE (or PlatformIO).
2. Select the correct ESP32 board + COM port.
3. Upload.
4. Open Serial Monitor @ 115200 to see logs like:
   ```
   === ESP32 BLE Server Demo Start ===
   [BLE] Advertising started. Use Python client to connect.
   [BLE] Client connected
   [BLE] Notified: CNT:1
   ...
   ```

## Python Environment
```bash
pip install bleak
```
(Windows 10/11 already supports BLE; make sure Bluetooth is enabled.)

## Run Python Client
```bash
python python_ble_client.py
```
Expected output:
```
[SCAN] Scanning for ESP32-BLE-DEMO or service 12345678-1234-1234-1234-1234567890ab...
[SCAN] Found target: XX:XX:XX:XX:XX:XX (ESP32-BLE-DEMO)
[CONNECT] Connecting to XX:XX:XX:XX:XX:XX ...
[CONNECT] Connected
[SUB] Subscribing to notifications...
[WRITE] Sending command: hello-from-pc
[NOTIFY] ... CNT:1
[NOTIFY] ... CNT:2
[NOTIFY] ... RESP:hello-from-pc
```

## Customizing
- Change `DEVICE_NAME` or UUIDs in `esp32_ble_server.ino` if you have multiple ESP32 devices.
- Replace the counter payload with real sensor data (e.g., distance from VL53L0X) in the `loop()`:
  ```cpp
  // Example: char payload[32]; snprintf(payload, sizeof(payload), "DIST:%u", distance_mm);
  ```
- For binary data, build a small struct and send bytes with `setValue((uint8_t*)&structObj, sizeof(structObj));`.

## Troubleshooting
| Issue | Fix |
|-------|-----|
| Python scan finds nothing | Move ESP32 closer, ensure advertising started, disable other BLE apps |
| Connect fails | Power cycle ESP32, re-upload sketch, update ESP32 Arduino core |
| Notifications not received | Check you subscribed to the NOTIFY characteristic UUID |
| Write errors | Ensure you used the WRITE characteristic UUID, not the notify one |
| Garbled text | Confirm UTF-8 strings; for binary remove `.decode()` in handler |

## Extending
- Add a second notify char for high-rate sensor streaming.
- Implement a simple command protocol: `SET_RATE:100`, `PING`, etc.
- Use a ring buffer and packet sequence numbers to detect drops.

## License
Demo code provided as-is for educational purposes.
