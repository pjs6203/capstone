# BLE Strap Monitor 실행 가이드

ESP32 스트랩 모니터링 시스템(ESP32 펌웨어 + Python 백엔드 + React 프론트엔드)을 로컬에서 실행하기 위한 필수 준비 작업과 실행 절차만 정리했습니다.

## 준비 사항
- ESP32 개발 보드 1대, VL53L0X 거리 센서, 홀 센서(KY-035 등), 릴레이 모듈, 버저
- 센서 및 액추에이터 배선: VL53L0X SDA→GPIO4, SCL→GPIO5 / 홀 센서 AOUT→GPIO7 / 릴레이→GPIO23 / 버저→GPIO10 (필요 시 코드 상단 상수로 변경 가능)
- Windows 10/11 PC (블루투스 활성화), Arduino IDE(ESP32 보드 패키지 2.x), Python 3.10 이상, Node.js 18 이상, Git
- Arduino 라이브러리: Pololu `VL53L0X`, `ESP32 BLE Arduino` (기본 포함)

## 1. ESP32 펌웨어 업로드
1. Arduino IDE에서 `esp32/esp32_firmware.ino`를 엽니다.
2. `Tools > Board`에서 사용 중인 ESP32 보드와 COM 포트를 선택합니다.
3. 필요 시 상단의 핀/버저/릴레이 설정 상수를 하드웨어에 맞게 수정합니다.
4. 스케치를 업로드하고, 시리얼 모니터(115200bps)에서 `[BLE] Advertising started` 메시지로 준비 완료 여부를 확인합니다.

## 2. 백엔드 준비 및 실행
1. PowerShell에서 백엔드 폴더로 이동합니다.
  ```powershell
  cd ble-strap-monitor\backend
  ```
2. (선택) 가상환경을 만들고 활성화합니다.
  ```powershell
  python -m venv .venv
  .\.venv\Scripts\Activate.ps1
  ```
3. 필요한 패키지를 설치합니다.
  ```powershell
  pip install -r requirements.txt
  ```
4. 서버를 실행합니다.
  ```powershell
  python app.py
  ```
  - 최초 실행 시 같은 폴더에 `strap_monitor.db`가 자동 생성됩니다.
  - 관리자 계정 기본값은 `admin / admin123`입니다.
  - 백엔드는 BLE 디바이스 루프가 단일 프로세스에서 돌아야 하므로 `flask run` 대신 `python app.py`를 사용하세요.

## 3. 프론트엔드 준비 및 실행
1. 새 PowerShell 창에서 프론트엔드 폴더로 이동합니다.
  ```powershell
  cd ble-strap-monitor\frontend
  ```
2. 의존성을 설치합니다.
  ```powershell
  npm install
  ```
3. 개발 서버를 실행합니다.
  ```powershell
  npm run dev
  ```
4. 브라우저에서 `http://localhost:3000`을 열고, 백엔드 관리자 페이지(`http://localhost:5000/admin`)와 같은 자격증명으로 로그인합니다.

## 4. 실행 흐름
- 백엔드를 먼저 실행하고, 이어서 프론트엔드를 실행합니다.
- 관리자 페이지에 접속해 BLE 스캔 → ESP32 디바이스 등록을 수행하면 자동으로 연결이 유지됩니다.
- 릴레이/버저 테스트, 정책 설정 등은 관리자 페이지의 디버그 패널에서 사용할 수 있습니다.

## 5. 기본 점검
- Windows 블루투스가 꺼져 있으면 백엔드가 ESP32를 찾을 수 없습니다.
- 다른 BLE 앱(nRF Connect 등)이 ESP32에 연결되어 있으면 백엔드 연결이 거부됩니다.
- 핀 배선을 변경한 경우 `esp32_firmware.ino` 상단 상수를 함께 수정해야 합니다.
