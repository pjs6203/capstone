// 자동 보정 + BLE 통합: VL53L0X + KY-035(AOUT->GPIO7) + BLE
// - Pololu VL53L0X 라이브러리
// - KY-035: VCC=3.3V, GND=GND, AOUT->GPIO7
// - VL53L0X I2C: SDA->GPIO4, SCL->GPIO5 (기존 하드웨어 호환)
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
const int BUZZER_PIN   = 10;  // 하드웨어에 맞게 조정 (Flash 핀과 충돌하지 않는 GPIO 권장)
const bool BUZZER_USE_TONE = true;          // 수동형(피에조) 버저면 true, 능동형이면 false
const bool BUZZER_ACTIVE_HIGH = true;       // BUZZER_USE_TONE=false 일 때 HIGH로 켜지면 true, LOW로 켜지면 false
const int RELAY_PIN    = 18; // 필요 시 하드웨어 구성에 맞게 변경
const bool RELAY_ACTIVE_HIGH = true; // 릴레이 모듈이 HIGH에서 동작하면 true

const uint16_t DEFAULT_BUZZER_FREQ = 2000;

bool relayLatched = false;
bool buzzerLatched = false;
uint16_t buzzerCurrentFreq = DEFAULT_BUZZER_FREQ;

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
void handleRelayCommand(const String& rawArg);
void handleBuzzerCommand(const String& rawArg);
void handleGpioCommand(const String& rawArg, bool force = false);
bool isSafeGpio(int pinNumber);
void setRelayState(bool enabled);
void applyBuzzerOutput(bool enabled, uint16_t freq = DEFAULT_BUZZER_FREQ);
void stopBuzzerTone();
uint32_t parseDurationToken(const String& token, uint32_t fallback, uint32_t minValue, uint32_t maxValue);
bool parsePinStateToken(const String& token, bool& activeHigh);

class StrapWriteCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    // 일부 BLE 라이브러리 변형에서 getValue() 가 Arduino String 을 반환하므로 String 사용
    String v = c->getValue();
    if(!v.length()) return;

    // 입력값 정리: 앞뒤 공백/개행 제거, 내부 제어문자 제거
    // 일부 클라이언트는 '\r'이나 '\n'을 붙여 전송하므로 이를 제거해야 정확히 매칭됩니다.
    // String::endsWith()는 char 인수를 받지 않으므로 charAt()로 마지막 문자를 검사합니다.
    while (v.length() > 0 && (v.charAt(v.length() - 1) == '\n' || v.charAt(v.length() - 1) == '\r')) {
      v.remove(v.length() - 1);
    }
    v.trim();

    Serial.print("[CMD] "); Serial.println(v);

    // 대소문자 구분 없이 매칭하기 위한 Upper 버전
    String U = v;
    U.toUpperCase();

    if(U.startsWith("RATE:")){
      uint32_t nv = v.substring(5).toInt();
      measureIntervalMs = clampRate(nv);
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:RATE=%lu",(unsigned long)measureIntervalMs);
    } else if(U == "ONCE") {
      // 기존 g_notifyBuf 에 마지막 데이터가 들어있다고 가정; 즉시 전송
      sendData(true);
      return;
    } else if(U == "CAL") {
      startCalibration();
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:CAL-OK");
    } else if(U == "BEEP") {
      applyBuzzerOutput(true, DEFAULT_BUZZER_FREQ);
      delay(120);
      applyBuzzerOutput(false);
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:BEEP");
    } else if(U == "STATE") {
      snprintf(g_notifyBuf,sizeof(g_notifyBuf),"RESP:STATE=%s", stateNow==STRAP_OPEN?"OPEN":"CLOSED");
    } else if(U.startsWith("RELAY:")) {
      handleRelayCommand(v.substring(6));
    } else if(U.startsWith("BUZZER:")) {
      handleBuzzerCommand(v.substring(7));
    } else if(U.startsWith("GPIOF:")) {
      // Forced GPIO (bypass safe-pin check when firmware supports it)
      handleGpioCommand(v.substring(6), true);
    } else if(U.startsWith("GPIO:")) {
      handleGpioCommand(v.substring(5), false);
    } else if(U.startsWith("POLICY:")) {
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

void setRelayState(bool enabled) {
  const bool driveHigh = RELAY_ACTIVE_HIGH ? enabled : !enabled;
  digitalWrite(RELAY_PIN, driveHigh ? HIGH : LOW);
  relayLatched = enabled;
}

void applyBuzzerOutput(bool enabled, uint16_t freq) {
  if (enabled) {
    if (BUZZER_USE_TONE) {
      uint16_t target = freq >= 50 ? freq : DEFAULT_BUZZER_FREQ;
      tone(BUZZER_PIN, target);
      buzzerCurrentFreq = target;
    } else {
      digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? HIGH : LOW);
      buzzerCurrentFreq = freq;
    }
    buzzerLatched = true;
  } else {
    if (BUZZER_USE_TONE) {
      noTone(BUZZER_PIN);
    }
    digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? LOW : HIGH);
    buzzerLatched = false;
  }
}

void stopBuzzerTone() {
  applyBuzzerOutput(false);
}

uint32_t parseDurationToken(const String& token, uint32_t fallback, uint32_t minValue, uint32_t maxValue) {
  long parsed = token.toInt();
  if (parsed <= 0) return fallback;
  if (parsed < static_cast<long>(minValue)) return minValue;
  if (parsed > static_cast<long>(maxValue)) return maxValue;
  return static_cast<uint32_t>(parsed);
}

bool parsePinStateToken(const String& token, bool& activeHigh) {
  String upper = token;
  upper.trim();
  upper.toUpperCase();
  if (upper == "1" || upper == "HIGH" || upper == "ON") {
    activeHigh = true;
    return true;
  }
  if (upper == "0" || upper == "LOW" || upper == "OFF") {
    activeHigh = false;
    return true;
  }
  return false;
}

bool isSafeGpio(int pinNumber) {
  if (pinNumber < 0 || pinNumber > 39) return false;
#if defined(ARDUINO_ARCH_ESP32)
  if (pinNumber >= 34 && pinNumber <= 39) return false; // 입력 전용 핀 차단
  if (pinNumber >= 6 && pinNumber <= 11) return false;  // 플래시/SPI 핀 차단
#endif
  if (pinNumber == SDA_PIN || pinNumber == SCL_PIN || pinNumber == HALL_ADC_PIN ||
      pinNumber == BUZZER_PIN || pinNumber == RELAY_PIN) {
    return false;
  }
  return true;
}

void handleRelayCommand(const String& rawArg) {
  String arg = rawArg;
  arg.trim();
  String upper = arg;
  upper.toUpperCase();

  if (upper == "ON") {
    setRelayState(true);
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:RELAY=%s", relayLatched ? "ON" : "OFF");
  } else if (upper == "OFF") {
    setRelayState(false);
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:RELAY=%s", relayLatched ? "ON" : "OFF");
  } else if (upper.startsWith("PULSE")) {
    uint32_t duration = 200;
    int sep = arg.indexOf(':');
    if (sep >= 0) {
      duration = parseDurationToken(arg.substring(sep + 1), 200, 20, 5000);
    }
    setRelayState(true);
    delay(duration);
    setRelayState(false);
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:RELAY=PULSE,%lu", static_cast<unsigned long>(duration));
  } else {
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:RELAY=ERR");
  }
}

void handleBuzzerCommand(const String& rawArg) {
  String arg = rawArg;
  arg.trim();
  String upper = arg;
  upper.toUpperCase();

  if (upper.startsWith("ON")) {
    uint16_t freq = DEFAULT_BUZZER_FREQ;
    int sep = arg.indexOf(':');
    if (sep >= 0) {
      long parsed = arg.substring(sep + 1).toInt();
      if (parsed >= 100 && parsed <= 8000) {
        freq = static_cast<uint16_t>(parsed);
      }
    }
    applyBuzzerOutput(true, freq);
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:BUZZER=%s,%u", buzzerLatched ? "ON" : "OFF", buzzerCurrentFreq);
  } else if (upper == "OFF") {
    stopBuzzerTone();
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:BUZZER=OFF");
  } else if (upper.startsWith("PULSE")) {
    uint32_t duration = 180;
    uint16_t freq = DEFAULT_BUZZER_FREQ;
    int first = arg.indexOf(':');
    if (first >= 0) {
      String tail = arg.substring(first + 1);
      tail.trim();
      int second = tail.indexOf(':');
      if (second < 0) {
        duration = parseDurationToken(tail, 180, 20, 4000);
      } else {
        String durToken = tail.substring(0, second);
        String freqToken = tail.substring(second + 1);
        duration = parseDurationToken(durToken, 180, 20, 4000);
        long parsedFreq = freqToken.toInt();
        if (parsedFreq >= 100 && parsedFreq <= 8000) {
          freq = static_cast<uint16_t>(parsedFreq);
        }
      }
    }
    applyBuzzerOutput(true, freq);
    delay(duration);
    applyBuzzerOutput(false);
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:BUZZER=PULSE,%u,%lu", buzzerCurrentFreq, static_cast<unsigned long>(duration));
  } else {
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:BUZZER=ERR");
  }
}

void handleGpioCommand(const String& rawArg, bool force) {
  String arg = rawArg;
  arg.trim();
  int first = arg.indexOf(':');
  if (first < 0) {
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:GPIO=ERR,FORMAT");
    return;
  }

  int pin = arg.substring(0, first).toInt();
  String remainder = arg.substring(first + 1);
  remainder.trim();

  int second = remainder.indexOf(':');
  String stateToken = (second < 0) ? remainder : remainder.substring(0, second);
  stateToken.trim();

  bool driveHigh = false;
  if (!parsePinStateToken(stateToken, driveHigh)) {
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:GPIO=ERR,STATE");
    return;
  }

  uint32_t duration = 0;
  if (second >= 0) {
    String durationToken = remainder.substring(second + 1);
    durationToken.trim();
    duration = parseDurationToken(durationToken, 0, 0, 10000);
  }

  if (!force && !isSafeGpio(pin)) {
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:GPIO=ERR,PIN");
    return;
  }

  // 읽기 전 상태(복원용)를 먼저 읽어둡니다. pinMode 변경 전 digitalRead로 값 획득.
  int prevLevel = digitalRead(pin); // 0 또는 1

  pinMode(pin, OUTPUT);
  digitalWrite(pin, driveHigh ? HIGH : LOW);

  if (duration > 0) {
    // 요청된 시간만큼 유지
    delay(duration);

    // 유지 시간 후, 가능한 경우 이전 레벨로 복원
    bool restoredHigh = (prevLevel != 0);
    digitalWrite(pin, restoredHigh ? HIGH : LOW);

    // 최종 상태 정보를 포함한 응답
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:GPIO=%d,%s,%lu,FINAL=%s",
             pin,
             driveHigh ? "HIGH" : "LOW",
             static_cast<unsigned long>(duration),
             restoredHigh ? "HIGH" : "LOW");
  } else {
    // 지속 유지 (복귀 없음)
    snprintf(g_notifyBuf, sizeof(g_notifyBuf), "RESP:GPIO=%d,%s", pin, driveHigh ? "HIGH" : "LOW");
  }
}

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
  applyBuzzerOutput(true, DEFAULT_BUZZER_FREQ);
  delay(ms);
  applyBuzzerOutput(false);
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
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, BUZZER_ACTIVE_HIGH ? LOW : HIGH);
  stopBuzzerTone();
  pinMode(RELAY_PIN, OUTPUT);
  setRelayState(false);

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
    Serial.print(" Buzzer = "); Serial.print(buzzerLatched);
    Serial.print(" Relay = "); Serial.print(relayLatched);
    if (!calib_done) Serial.print("  [CAL_NOT_DONE]");
    Serial.println();

    // 상태 판정: 사용자 요청에 따라 "착용"은 홀센서 평균값 <= 500 AND
    // 거리센서가 유효하고 거리가 닫힘(wearPolicy.distanceClose) 조건을 만족할 때만으로 정의합니다.
    // 두 조건 중 하나라도 만족하지 않으면 미착용(OPEN)으로 처리합니다.
    StrapState target = stateNow;

    // 홀센서 기준: 이동평균값(avg) 사용. 사용자가 지정한 임계값 500 이하일 때 "홀센서 조건 충족"
    bool hallCondition = (avg <= 500);

    // 거리센서 기준: 거리측정이 유효하고 wearPolicy.distanceClose 이하일 때 "거리 조건 충족"
    bool distanceValid = (dist != 0xFFFF);
    bool distanceCondition = false;
    if (wearPolicy.distanceEnabled && distanceValid) {
      distanceCondition = (dist <= wearPolicy.distanceClose);
    }

    // 최종: 둘 다 충족하면 착용(STRAP_CLOSED), 아니면 미착용(STRAP_OPEN)
    if (hallCondition && distanceCondition) {
      target = STRAP_CLOSED;
    } else {
      target = STRAP_OPEN;
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
