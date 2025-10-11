# BLE Strap Monitor - ESP32 헬멧 스트랩 모니터링 시스템

ESP32 BLE 디바이스의 헬멧 스트랩 착용 상태를 실시간으로 모니터링하는 풀스택 웹 애플리케이션입니다.

## 📋 시스템 구성

```
┌─────────────────┐
│   ESP32 기기들   │ ← BLE Peripheral (자동 재광고)
└────────┬────────┘
         │ BLE
         ↓
┌─────────────────┐
│  Python Backend │ ← Flask + Bleak + WebSocket
│  - BLE 스캔      │
│  - 다중 연결 관리 │
│  - 실시간 데이터  │
└────────┬────────┘
         │ HTTP/WS
         ↓
┌─────────────────┐
│  React Frontend │ ← Vite + TypeScript + Tailwind
│  - 관리자 페이지  │
│  - 실시간 차트    │
└─────────────────┘
```

## 🚀 빠른 시작

### 1. ESP32 펌웨어 업로드

```bash
# Arduino IDE에서 esp32_firmware.ino 열기
# ESP32 보드 선택
# 업로드
```

펌웨어는 이미 **연결 끊김 시 자동 광고 재시작** 기능이 구현되어 있습니다!

### 2. 백엔드 실행 (Python)

```powershell
# 백엔드 디렉토리로 이동
cd backend

# 가상환경 생성 (선택사항)
python -m venv venv
.\venv\Scripts\Activate.ps1

# 의존성 설치
pip install -r requirements.txt

# 서버 실행
python app.py
```

서버가 `http://localhost:5000`에서 실행됩니다.

### 3. 프론트엔드 실행 (React)

```powershell
# 프론트엔드 디렉토리로 이동
cd frontend

# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
```

브라우저에서 `http://localhost:3000`을 열면 관리자 페이지가 나타납니다.

## 📱 기능 상세

### 백엔드 API

#### REST API
- `GET /api/health` - 서버 상태 확인
- `POST /api/scan` - BLE 디바이스 스캔 (5초)
- `GET /api/devices` - 등록된 디바이스 목록
- `POST /api/devices/register` - 디바이스 등록 및 자동 연결
- `DELETE /api/devices/:id` - 디바이스 삭제
- `POST /api/devices/:id/command` - 명령 전송

#### WebSocket 이벤트
- `device_data` - 실시간 센서 데이터
- `device_connected` - 디바이스 연결 알림
- `device_disconnected` - 디바이스 연결 해제 알림
- `scan_complete` - 스캔 완료 알림

### 프론트엔드 기능

#### 디바이스 스캐너
- BLE 스캔 버튼
- 발견된 ESP32 디바이스 목록
- 원클릭 등록

#### 디바이스 관리
- 연결 상태 실시간 표시
- 최근 데이터 미리보기
- 빠른 명령 버튼
  - `ONCE` - 즉시 측정
  - `CAL` - 재보정
  - `BEEP` - 테스트 비프
  - `STATE` - 상태 확인

#### 실시간 대시보드
- 요약 통계 (총 디바이스, 연결됨, 착용 중)
- 디바이스별 실시간 차트
  - 거리 측정값 (VL53L0X)
  - 홀센서 차이값
  - 착용/미착용 상태

## 🔧 ESP32 BLE 프로토콜

### 서비스 UUID
```
7b4fb520-5f6e-4b65-9c31-9100d7c0d001
```

### Notify 특성 (데이터 수신)
```
UUID: 7b4fb520-5f6e-4b65-9c31-9100d7c0d002
포맷: DIST:<mm|ERR>;RAW:<raw>;AVG:<avg>;DIFF:<diff>;STATE:<OPEN|CLOSED>
```

예시:
```
DIST:250;RAW:1234;AVG:1240;DIFF:85;STATE:CLOSED
DIST:ERR;RAW:1180;AVG:1175;DIFF:15;STATE:OPEN
```

### Write 특성 (명령 전송)
```
UUID: 7b4fb520-5f6e-4b65-9c31-9100d7c0d003
명령:
  - RATE:<ms>  (50~2000) - 측정 주기 변경
  - ONCE       - 즉시 한 번 측정
  - CAL        - 재보정 수행
  - BEEP       - 짧은 비프음
  - STATE      - 현재 상태 응답
```

## 🎨 UI/UX 특징

### 디자인 시스템
- **프레임워크**: React 18 + TypeScript
- **스타일링**: Tailwind CSS
- **아이콘**: Lucide React
- **차트**: Recharts
- **색상 테마**: 
  - Primary: Blue (0ea5e9)
  - Success: Green (10b981)
  - Warning: Orange (f59e0b)
  - Danger: Red (ef4444)

### 반응형 디자인
- 모바일 / 태블릿 / 데스크톱 최적화
- 실시간 차트 반응형 크기 조절
- 터치 친화적 버튼 크기

## 🔒 보안 고려사항

현재는 데모 버전으로 인증이 없습니다. 프로덕션 배포 시 추가할 사항:

1. **백엔드**
   - JWT 인증
   - HTTPS 강제
   - CORS 제한
   - Rate limiting

2. **프론트엔드**
   - 로그인 페이지
   - 토큰 관리
   - 환경변수 분리

## 📊 데이터 흐름

```
ESP32 (BLE Notify)
  → Python Backend (Bleak)
    → WebSocket Broadcast
      → React Frontend (Socket.IO Client)
        → 상태 업데이트 & 차트 렌더링
```

## 🐛 트러블슈팅

### BLE 스캔이 안 될 때
- Windows Bluetooth 설정에서 Bluetooth가 켜져 있는지 확인
- ESP32가 광고 중인지 시리얼 모니터로 확인
- 다른 BLE 앱 (nRF Connect 등) 종료

### 연결이 끊길 때
- ESP32는 자동으로 재광고하므로 잠시 대기
- 백엔드는 자동 재연결 시도 (추후 구현 가능)
- 디바이스를 삭제 후 재등록

### 데이터가 안 올 때
- 백엔드 로그 확인 (`python app.py` 터미널)
- 브라우저 개발자 도구 → Network → WS 탭 확인
- WebSocket 연결 상태 확인

## 📦 빌드 & 배포

### 프론트엔드 빌드
```bash
cd frontend
npm run build
# dist/ 폴더에 정적 파일 생성
```

### 백엔드 프로덕션
```bash
# gunicorn 설치
pip install gunicorn eventlet

# 실행
gunicorn --worker-class eventlet -w 1 -b 0.0.0.0:5000 app:app
```

## 🛠️ 향후 개선 사항

- [ ] 자동 재연결 로직 강화
- [ ] 데이터 히스토리 DB 저장 (SQLite/PostgreSQL)
- [ ] 알림 기능 (이메일, SMS, 푸시)
- [ ] 다중 사용자 권한 관리
- [ ] 디바이스 그룹핑
- [ ] 통계 리포트 생성
- [ ] PWA 지원 (오프라인 사용)

## 📄 라이선스

MIT License

## 👤 작성자

Capstone 프로젝트 - ESP32 BLE 모니터링 시스템
