// 자동 보정 + BLE 통합: VL53L0X + KY-035(AOUT->GPIO7) + BLE
// - Pololu VL53L0X 라이브러리
// - KY-035: VCC=3.3V, GND=GND, AOUT->GPIO7
// - BLE Notify 포맷: DIST:<mm>;RAW:<hall_raw>;AVG:<hall_avg>;DIFF:<diff>;STATE:<OPEN|CLOSED>
// - BLE Write 명령:
//      RATE:<ms>  (50~2000) 측정 주기 변경
//      ONCE       즉시 한 번 알림
//      CAL        재보정 수행
//      BEEP       짧은 비프
//      STATE      현재 상태 1회 응답
// Python 클라이언트는 DIST: 프리픽스를 이용해 기존 로직과 호환 가능.

#include <Wire.h>
#include <VL53L0X.h>
#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEServer.h>

const int SDA_PIN      = 4;
const int SCL_PIN      = 5;
const int HALL_ADC_PIN = 7;
const int BUZZER_PIN   = 10;

VL53L0X tof;
uint32_t measureIntervalMs = 120; // 동적 변경 (RATE 명령)
const uint16_t VL_TIMEOUT_MS = 200;

// 필터/버퍼
const int ADC_RESOLUTION = 12;
const int MOVAVG_WIN = 12;
uint16_t movBuf[MOVAVG_WIN];
int movIdx = 0; uint32_t movSum = 0;

uint32_t baseline_no_mag = 0;
uint32_t baseline_with_mag = 0;
bool calib_done = false;
bool hallMagDecreases = true;

// 동적 임계값(자동 계산)
uint32_t observed_diff = 0;
uint16_t THRESH_CLOSE_COUNTS = 220;
uint16_t THRESH_OPEN_COUNTS  = 120;

struct WearPolicyConfig {
  bool distanceEnabled;
  uint16_t distanceClose;
  uint16_t distanceOpen;
};

WearPolicyConfig wearPolicy = { true, 120, 160 };
bool policyReceived = false;
uint16_t lastDistanceMm = 0xFFFF;

// 상태/타이머
enum StrapState { STRAP_OPEN=0, STRAP_CLOSED=1 };
StrapState stateNow = STRAP_OPEN;
uint32_t openSince = 0, lastBeepAt = 0;
uint32_t lastMeasureMs = 0;

// 동작 파라미터
const uint32_t STABLE_MS      = 120;
// ===== BLE 구성 =====
static const char* BLE_DEVICE_NAME = "ESP32-STRAP";
#define STRAP_SERVICE_UUID   "7b4fb520-5f6e-4b65-9c31-9100d7c0d001"
#define STRAP_NOTIFY_UUID    "7b4fb520-5f6e-4b65-9c31-9100d7c0d002"
#define STRAP_WRITE_UUID     "7b4fb520-5f6e-4b65-9c31-9100d7c0d003"
BLEServer* g_server = nullptr; BLECharacteristic* g_notify = nullptr; BLECharacteristic* g_write = nullptr;
bool g_bleConnected = false; char g_notifyBuf[160];

class StrapServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override { g_bleConnected = true; Serial.println("[BLE] Client connected"); }
  void onDisconnect(BLEServer* s) override { g_bleConnected = false; Serial.println("[BLE] Client disconnected - advertising..."); BLEDevice::startAdvertising(); }
};

static uint32_t clampRate(uint32_t v){ if(v<50)v=50; if(v>2000)v=2000; return v; }
void startCalibration(); // fwd
void sendData(bool force);

class StrapWriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    // 일부 BLE 라이브러리 변형에서 getValue() 가 Arduino String 을 반환하므로 String 사용
    String v = c->getValue();
    if(!v.length()) return;
    Serial.print("[CMD] "); Serial.println(v);

    if(v.startsWith("RATE:")){
      uint32_t nv = v.substring(5).toInt();
      measureIntervalMs = clampRate(nv);
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:RATE=%lu",(unsigned long)measureIntervalMs);
    } else if(v == "ONCE") {
      // 기존 g_notifyBuf 에 마지막 데이터가 들어있다고 가정; 즉시 전송
      sendData(true);
      return;
    } else if(v == "CAL") {
      startCalibration();
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:CAL-OK");
    } else if(v == "BEEP") {
      tone(BUZZER_PIN,2000); delay(120); noTone(BUZZER_PIN);
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:BEEP");
    } else if(v == "STATE") {
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:STATE=%s", stateNow==STRAP_OPEN?"OPEN":"CLOSED");
    } else if(v.startsWith("POLICY:")) {
      String payload = v.substring(7);
      payload.trim();
      WearPolicyConfig newPolicy = wearPolicy;

      int start = 0;
      while (start < payload.length()) {
        int end = payload.indexOf(';', start);
        if (end < 0) end = payload.length();
        String token = payload.substring(start, end);
        token.trim();

        int eq = token.indexOf('=');
        if (eq > 0) {
          String key = token.substring(0, eq);
          String value = token.substring(eq + 1);
          key.trim(); value.trim();
          key.toUpperCase();

          if (key == "DIST_EN") {
            newPolicy.distanceEnabled = value.toInt() != 0;
          } else if (key == "DIST_CLOSE") {
            newPolicy.distanceClose = constrain(value.toInt(), 30, 400);
          } else if (key == "DIST_OPEN") {
            newPolicy.distanceOpen = constrain(value.toInt(), 40, 500);
          }
        }

        start = end + 1;
      }

      if (newPolicy.distanceOpen <= newPolicy.distanceClose) {
        newPolicy.distanceOpen = newPolicy.distanceClose + 10;
      }

      wearPolicy = newPolicy;
      policyReceived = true;
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:POLICY=%d,%u,%u",
               wearPolicy.distanceEnabled ? 1 : 0,
               wearPolicy.distanceClose,
               wearPolicy.distanceOpen);
    } else {
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:UNKNOWN");
    }
    if(g_notify){ g_notify->setValue((uint8_t*)g_notifyBuf, strlen(g_notifyBuf)); g_notify->notify(); }
  }
};

void setupBLE(){
  BLEDevice::init(BLE_DEVICE_NAME);
  g_server = BLEDevice::createServer(); g_server->setCallbacks(new StrapServerCallbacks());
  BLEService* svc = g_server->createService(STRAP_SERVICE_UUID);
  g_notify = svc->createCharacteristic(STRAP_NOTIFY_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  g_notify->setValue("BOOT");
  g_write  = svc->createCharacteristic(STRAP_WRITE_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  g_write->setCallbacks(new StrapWriteCallbacks());
  svc->start(); BLEAdvertising* adv = BLEDevice::getAdvertising(); adv->addServiceUUID(STRAP_SERVICE_UUID); adv->setScanResponse(true); adv->setMinPreferred(0x06); adv->setMinPreferred(0x12); BLEDevice::startAdvertising();
  Serial.println("[BLE] Advertising started (ESP32-STRAP)");
}
const uint32_t OPEN_GRACE1_MS = 5000;
const uint32_t OPEN_GRACE2_MS = 30000;
const uint32_t BEEP_REPEAT_MS = 4000;

// 유틸
uint16_t readADCavg(uint8_t samples=6) {
#if defined(ARDUINO_ARCH_ESP32)
  analogReadResolution(ADC_RESOLUTION);
  analogSetPinAttenuation(HALL_ADC_PIN, ADC_11db); // 전체 범위 허용
#endif
  uint32_t acc=0;
  for (uint8_t i=0;i<samples;i++){ acc += analogRead(HALL_ADC_PIN); delayMicroseconds(200); }
  return (uint16_t)(acc / samples);
}

uint16_t movavgPush(uint16_t v) {
  movSum -= movBuf[movIdx];
  movBuf[movIdx] = v;
  movSum += v;
  movIdx = (movIdx + 1) % MOVAVG_WIN;
  return (uint16_t)(movSum / MOVAVG_WIN);
}

void beepOnce(uint16_t ms) {
  tone(BUZZER_PIN, 2000);
  delay(ms);
  noTone(BUZZER_PIN);
}

// VL setup
void setupVL() {
  if (!tof.init()) {
    Serial.println("[VL] init failed - check wiring/power/XSHUT");
  } else {
    Serial.println("[VL] init OK");
    tof.setTimeout(VL_TIMEOUT_MS);
    tof.startContinuous();
  }
}

// 자동 보정: 무자석 상태에서 평균 얻기
uint32_t measureMeanNoMag(uint32_t ms, uint8_t samplesPerRead=6) {
  Serial.printf("[CAL] Measure NO-MAG for %u ms: Keep magnet AWAY\n", ms);
  uint32_t t0 = millis(), acc=0, n=0;
  while (millis() - t0 < ms) {
    acc += readADCavg(samplesPerRead);
    n++;
  }
  if (n==0) n=1;
  return acc / n;
}
// 자동 보정: 자석 근접 상태에서 평균 얻기
uint32_t measureMeanWithMag(uint32_t ms, uint8_t samplesPerRead=6) {
  Serial.printf("[CAL] Measure WITH-MAG for %u ms: Bring magnet CLOSE now\n", ms);
  delay(400); // 사용자가 준비할 시간
  uint32_t t0 = millis(), acc=0, n=0;
  while (millis() - t0 < ms) {
    acc += readADCavg(samplesPerRead);
    n++;
  }
  if (n==0) n=1;
  return acc / n;
}

// 재보정(초기 & CAL 명령)
void startCalibration(){
  calib_done = false;
  baseline_no_mag = measureMeanNoMag(800,6);
  Serial.print("[CAL] baseline_no_mag = "); Serial.println(baseline_no_mag);
  Serial.println("[CAL] 준비되면 2초 후 WITH-MAG 시작"); delay(2000);
  baseline_with_mag = measureMeanWithMag(800,6);
  Serial.print("[CAL] baseline_with_mag = "); Serial.println(baseline_with_mag);
  int32_t signedObserved = (int32_t)baseline_with_mag - (int32_t)baseline_no_mag;
  observed_diff = signedObserved >= 0 ? (uint32_t)signedObserved : (uint32_t)(-signedObserved);
  hallMagDecreases = signedObserved < 0;
  Serial.print("[CAL] magnet effect = "); Serial.println(hallMagDecreases ? "ADC decrease" : "ADC increase");
  Serial.print("[CAL] observed_diff = "); Serial.println(observed_diff);
  if(observed_diff < 6){
    Serial.println("[WARN] diff too small -> manual adjust or reposition magnet");
    calib_done=false;
  }
  else {
    float closeFactor = hallMagDecreases ? 0.52f : 0.55f;
    float openFactor  = 0.34f;
  uint16_t computedClose = (uint16_t)(observed_diff * closeFactor + 0.5f);
  uint16_t computedOpen  = (uint16_t)(observed_diff * openFactor + 0.5f);

    if (computedClose < 8) computedClose = 8;
    if (computedOpen  < 4) computedOpen  = 4;

    if (computedOpen >= computedClose) {
      computedOpen = computedClose > 6 ? computedClose - 3 : computedClose / 2;
      if (computedOpen < 4) computedOpen = 4;
    }

    THRESH_CLOSE_COUNTS = computedClose;
    THRESH_OPEN_COUNTS  = computedOpen;
    calib_done=true;
    Serial.print("[CAL] Auto thresholds CLOSE="); Serial.print(THRESH_CLOSE_COUNTS);
    Serial.print(" OPEN="); Serial.println(THRESH_OPEN_COUNTS);
  }
}

void sendData(bool force){ if(!g_bleConnected && !force) return; if(g_notify){ g_notify->setValue((uint8_t*)g_notifyBuf, strlen(g_notifyBuf)); g_notify->notify(); } }

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n=== Auto-calib VL53L0X + KY-035 + BLE (GPIO7) ===");

  // I2C
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(400000);

  pinMode(HALL_ADC_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT); noTone(BUZZER_PIN);

  // 초깃값으로 이동평균 채움
  uint16_t v0 = readADCavg(8);
  movSum = 0;
  for (int i=0;i<MOVAVG_WIN;i++){ movBuf[i]=v0; movSum+=v0; }

  // VL init
  setupVL();

  startCalibration();

  // 준비 완료
  openSince = millis();
  lastMeasureMs = millis();
  Serial.println("[INFO] Calibration done. Running main loop...");
  setupBLE();
}

void loop() {
  uint32_t now = millis();
  // VL 측정(원래 동작 유지)
  if (!tof.timeoutOccurred() && (now - lastMeasureMs >= measureIntervalMs)) {
    lastMeasureMs = now;
    uint16_t dist = tof.readRangeContinuousMillimeters();
    if (!tof.timeoutOccurred()) {
      Serial.print("VL dist:");
      Serial.print(dist);
      Serial.print(" mm  ");
    } else {
      Serial.println("[VL] timeout reading");
      dist = 0xFFFF;
    }
    lastDistanceMm = dist;
    // HALL read
    uint16_t raw = readADCavg(6);
    uint16_t avg = movavgPush(raw);
    int32_t hallOffset = (int32_t)avg - (int32_t)baseline_no_mag;
    uint32_t diff = hallOffset >= 0 ? (uint32_t)hallOffset : (uint32_t)(-hallOffset);
    Serial.print("HALL raw="); Serial.print(raw);
    Serial.print(" avg="); Serial.print(avg);
    Serial.print(" base_no="); Serial.print(baseline_no_mag);
    Serial.print(" delta="); Serial.print(hallOffset);
    Serial.print(" |d|="); Serial.print(diff);
    if (!calib_done) Serial.print("  [CAL_NOT_DONE]");
    Serial.println();

    // 상태 판정 (자동 임계값 사용)
    StrapState target = stateNow;
    bool hallSuggestClosed = false;
    bool hallSuggestOpen = false;
    if (calib_done) {
      if (hallMagDecreases) {
        hallSuggestClosed = hallOffset <= -((int32_t)THRESH_CLOSE_COUNTS);
        hallSuggestOpen   = hallOffset >= -((int32_t)THRESH_OPEN_COUNTS);
      } else {
        hallSuggestClosed = hallOffset >= (int32_t)THRESH_CLOSE_COUNTS;
        hallSuggestOpen   = hallOffset <= (int32_t)THRESH_OPEN_COUNTS;
      }
    } else {
      // fallback: 보수적 임계값
      hallSuggestClosed = diff >= 300;
      hallSuggestOpen   = diff <= 50;
    }

    bool distanceValid = (dist != 0xFFFF);
    bool distanceSuggestClosed = false;
    bool distanceSuggestOpen = false;
    if (wearPolicy.distanceEnabled && distanceValid) {
      distanceSuggestClosed = dist <= wearPolicy.distanceClose;
      distanceSuggestOpen   = dist >= wearPolicy.distanceOpen;
    }

    if (stateNow == STRAP_OPEN) {
      bool closeCond = hallSuggestClosed;
      if (wearPolicy.distanceEnabled) {
        closeCond = closeCond && (distanceValid ? distanceSuggestClosed : false);
      }
      if (closeCond) {
        target = STRAP_CLOSED;
      }
    } else {
      bool openCond = hallSuggestOpen;
      if (wearPolicy.distanceEnabled) {
        if (!distanceValid) {
          openCond = true; // 거리 정보 없으면 안전하게 OPEN
        } else {
          openCond = openCond || distanceSuggestOpen;
        }
      }
      if (openCond) {
        target = STRAP_OPEN;
      }
    }

    static StrapState pending = STRAP_OPEN;
    static uint32_t pendAt = now;
    if (target != pending) { pending = target; pendAt = now; }
    if (pending != stateNow && (now - pendAt) >= STABLE_MS) {
      stateNow = pending;
      if (stateNow == STRAP_CLOSED) {
        Serial.println("[STATE] STRAP_CLOSED");
        beepOnce(80);
      } else {
        Serial.println("[STATE] STRAP_OPEN");
        openSince = now;
      }
    }

    // OPEN 알림
    if (stateNow == STRAP_OPEN) {
      uint32_t openDur = now - openSince;
      if (openDur >= OPEN_GRACE2_MS) {
        if (now - lastBeepAt > BEEP_REPEAT_MS) { beepOnce(600); lastBeepAt = now; }
      } else if (openDur >= OPEN_GRACE1_MS) {
        if (now - lastBeepAt > 10000UL) { for (int i=0;i<3;i++){ beepOnce(120); delay(120);} lastBeepAt = now; }
      }
    }

    // BLE 알림 문자열 구성
    if(dist==0xFFFF) snprintf(g_notifyBuf,sizeof(g_notifyBuf),"DIST:ERR;RAW:%u;AVG:%u;DIFF:%lu;STATE:%s", raw, avg, (unsigned long)diff, stateNow==STRAP_OPEN?"OPEN":"CLOSED");
    else snprintf(g_notifyBuf,sizeof(g_notifyBuf),"DIST:%u;RAW:%u;AVG:%u;DIFF:%lu;STATE:%s", dist, raw, avg, (unsigned long)diff, stateNow==STRAP_OPEN?"OPEN":"CLOSED");
    sendData(false);
  } // end measure interval
  delay(2);
}
