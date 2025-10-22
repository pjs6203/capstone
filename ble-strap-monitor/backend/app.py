"""
BLE Strap Monitor Backend - Professional Edition
Flask + SocketIO + Bleak + SQLite for ESP32 BLE communication
Features: Employee Management, Device Monitoring, Event Logging, Authentication
"""
import asyncio
import concurrent.futures
import logging
import hashlib
import os
from flask import Flask, jsonify, request, render_template, session, redirect, url_for
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from bleak import BleakScanner, BleakClient
import re
from datetime import datetime, timedelta
from threading import Thread, Lock
import time
import sqlite3
import json
from functools import wraps

# 로깅 설정
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-change-in-production'
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=8)
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# 한국 시간대 (UTC+9)
KST_OFFSET = timedelta(hours=9)

def get_kst_now():
    """현재 한국 시간 반환"""
    return datetime.utcnow() + KST_OFFSET

def to_kst_string(dt_string):
    """UTC 시간 문자열을 한국 시간 문자열로 변환"""
    try:
        if isinstance(dt_string, str):
            # ISO 형식 파싱
            dt = datetime.fromisoformat(dt_string.replace('Z', '').replace('+00:00', ''))
        else:
            dt = dt_string
        
        # UTC로 가정하고 KST로 변환
        kst_dt = dt + KST_OFFSET
        return kst_dt.strftime('%Y-%m-%d %H:%M:%S')
    except:
        return dt_string
# ESP32 BLE 설정
STRAP_SERVICE_UUID = "7b4fb520-5f6e-4b65-9c31-9100d7c0d001"
STRAP_NOTIFY_UUID = "7b4fb520-5f6e-4b65-9c31-9100d7c0d002"
STRAP_WRITE_UUID = "7b4fb520-5f6e-4b65-9c31-9100d7c0d003"

# 데이터 파싱 정규식
EXT_PAYLOAD_RE = re.compile(
    r"^DIST:(?P<dist>ERR|\d+);RAW:(?P<raw>\d+);AVG:(?P<avg>\d+);"
    r"DIFF:(?P<diff>\d+);STATE:(?P<state>OPEN|CLOSED)$"
)

# 글로벌 상태
devices_lock = Lock()
registered_devices = {}  # {device_id: {address, name, client, connected, last_data}}
scanning = False

# 착용 판정 정책 기본값 및 캐시
DEFAULT_WEAR_POLICY = {
    "distance_enabled": True,
    "distance_close": 120,
    "distance_open": 160
}

policy_lock = Lock()
policy_cache = None

# Database 초기화
def init_db():
    """SQLite 데이터베이스 초기화"""
    conn = sqlite3.connect('strap_monitor.db')
    c = conn.cursor()
    
    # 사용자 테이블 (로그인)
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    # 기본 관리자 계정 생성 (admin/admin123)
    import hashlib
    default_password = hashlib.sha256('admin123'.encode()).hexdigest()
    c.execute('''INSERT OR IGNORE INTO users (username, password_hash, role) 
                 VALUES ('admin', ?, 'admin')''', (default_password,))
    
    # 직원 테이블
    c.execute('''CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        employee_number TEXT UNIQUE NOT NULL,
        department TEXT,
        position TEXT,
        device_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    # 기기 테이블
    c.execute('''CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        address TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_connected TIMESTAMP
    )''')
    
    # 이벤트 로그 테이블
    c.execute('''CREATE TABLE IF NOT EXISTS event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        device_id TEXT NOT NULL,
        employee_id INTEGER,
        event_type TEXT NOT NULL,
        event_data TEXT,
        severity TEXT DEFAULT 'info'
    )''')
    
    # 착용 세션 테이블 (착용/해제 추적)
    c.execute('''CREATE TABLE IF NOT EXISTS wear_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER,
        device_id TEXT NOT NULL,
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP,
        duration_seconds INTEGER,
        is_active BOOLEAN DEFAULT 1
    )''')
    
    # 센서 데이터 로그 (샘플링)
    c.execute('''CREATE TABLE IF NOT EXISTS sensor_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        device_id TEXT NOT NULL,
        distance INTEGER,
        raw_hall INTEGER,
        avg_hall INTEGER,
        diff_hall INTEGER,
        state TEXT
    )''')

    # 시스템 설정 저장 테이블
    c.execute('''CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )''')

    # 착용 정책 기본값 저장
    c.execute('SELECT value FROM system_settings WHERE key = ?', ('wear_policy',))
    row = c.fetchone()
    if not row:
        c.execute('INSERT INTO system_settings (key, value) VALUES (?, ?)', (
            'wear_policy', json.dumps(DEFAULT_WEAR_POLICY)
        ))
        conn.commit()
    else:
        # 저장된 값이 손상된 경우 기본값으로 복구
        try:
            json.loads(row[0])
        except Exception:
            c.execute('UPDATE system_settings SET value = ? WHERE key = ?', (
                json.dumps(DEFAULT_WEAR_POLICY), 'wear_policy'
            ))
            conn.commit()
    
    conn.commit()
    conn.close()
    logger.info("Database initialized")

init_db()


def _normalize_wear_policy(policy: dict) -> dict:
    """입력된 착용 정책을 정규화"""
    normalized = DEFAULT_WEAR_POLICY.copy()
    if not isinstance(policy, dict):
        return normalized

    try:
        normalized['distance_enabled'] = bool(policy.get('distance_enabled', normalized['distance_enabled']))
    except Exception:
        normalized['distance_enabled'] = normalized['distance_enabled']

    try:
        dist_close = int(policy.get('distance_close', normalized['distance_close']))
    except Exception:
        dist_close = normalized['distance_close']

    try:
        dist_open = int(policy.get('distance_open', normalized['distance_open']))
    except Exception:
        dist_open = normalized['distance_open']

    # 합리적인 범위로 클램프 (30mm ~ 400mm)
    dist_close = max(30, min(400, dist_close))
    dist_open = max(dist_close + 10, min(500, dist_open))

    normalized['distance_close'] = dist_close
    normalized['distance_open'] = dist_open

    return normalized


def _load_wear_policy_from_db() -> dict:
    conn = sqlite3.connect('strap_monitor.db')
    c = conn.cursor()
    c.execute('SELECT value FROM system_settings WHERE key = ?', ('wear_policy',))
    row = c.fetchone()
    conn.close()

    if not row:
        return DEFAULT_WEAR_POLICY.copy()

    try:
        stored = json.loads(row[0])
        return _normalize_wear_policy(stored)
    except Exception as exc:
        logger.error(f"Failed to parse wear policy from DB: {exc}")
        return DEFAULT_WEAR_POLICY.copy()


def get_wear_policy() -> dict:
    """착용 정책을 반환 (캐시 사용)"""
    global policy_cache
    with policy_lock:
        if policy_cache is None:
            policy_cache = _load_wear_policy_from_db()
        return policy_cache.copy()


def save_wear_policy(policy: dict) -> dict:
    """착용 정책을 저장하고 반환"""
    normalized = _normalize_wear_policy(policy)
    value = json.dumps(normalized)

    conn = sqlite3.connect('strap_monitor.db')
    c = conn.cursor()
    c.execute('INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)', ('wear_policy', value))
    conn.commit()
    conn.close()

    global policy_cache
    with policy_lock:
        policy_cache = normalized.copy()

    return normalized.copy()


def build_policy_command(policy: dict) -> str:
    """BLE 디바이스로 전송할 POLICY 명령 문자열 생성"""
    normalized = _normalize_wear_policy(policy)
    distance_enabled = 1 if normalized.get('distance_enabled', True) else 0
    dist_close = int(normalized.get('distance_close', DEFAULT_WEAR_POLICY['distance_close']))
    dist_open = int(normalized.get('distance_open', DEFAULT_WEAR_POLICY['distance_open']))
    return f"POLICY:DIST_EN={distance_enabled};DIST_CLOSE={dist_close};DIST_OPEN={dist_open}"


def broadcast_wear_policy(policy: dict):
    """연결된 모든 디바이스에 정책을 전파"""
    command = build_policy_command(policy)

    with devices_lock:
        managers = [device['manager'] for device in registered_devices.values()
                    if device.get('manager')]

    started_at = get_kst_now().isoformat()

    def run_broadcast(targets):
        total = len(targets)
        socketio.emit('policy_push_summary', {
            'status': 'started',
            'timestamp': started_at,
            'total': total,
            'command': command
        }, namespace='/')

        if total == 0:
            socketio.emit('policy_push_summary', {
                'status': 'completed',
                'timestamp': get_kst_now().isoformat(),
                'total': 0,
                'success': 0,
                'failed': 0,
                'command': command
            }, namespace='/')
            return

        success_count = 0
        failure_count = 0

        for manager in targets:
            success = False
            error = None
            loop = getattr(manager, 'loop', None)

            if loop and loop.is_running():
                future = asyncio.run_coroutine_threadsafe(manager.send_command(command), loop)
                try:
                    future.result(timeout=10)
                    success = True
                    success_count += 1
                except concurrent.futures.TimeoutError:
                    error = '명령 전송 시간이 초과되었습니다.'
                    failure_count += 1
                    future.cancel()
                except Exception as exc:
                    error = str(exc)
                    failure_count += 1
                    logger.error(f"Failed to push policy to {manager.device_id}: {exc}")
            else:
                error = '디바이스 연결 루프가 실행 중이 아닙니다.'
                failure_count += 1

            socketio.emit('policy_push_result', {
                'device_id': manager.device_id,
                'success': success,
                'error': error,
                'timestamp': get_kst_now().isoformat(),
                'command': command,
                'connected': manager.connected
            }, namespace='/')

        socketio.emit('policy_push_summary', {
            'status': 'completed',
            'timestamp': get_kst_now().isoformat(),
            'total': total,
            'success': success_count,
            'failed': failure_count,
            'command': command
        }, namespace='/')

    Thread(target=run_broadcast, args=(managers,), daemon=True).start()
    return len(managers)


def load_devices_from_db():
    """DB에서 등록된 기기 목록 로드 및 자동 연결 시도"""
    conn = sqlite3.connect('strap_monitor.db')
    c = conn.cursor()
    c.execute('SELECT id, address, name FROM devices')
    rows = c.fetchall()
    conn.close()
    
    for device_id, address, name in rows:
        logger.info(f"Loading device from DB: {name} ({address})")
        manager = DeviceManager(device_id, address, name)
        with devices_lock:
            registered_devices[device_id] = {
                'address': address,
                'name': name,
                'manager': manager,
                'connected': False,
                'last_data': None
            }
        
        # 백그라운드에서 연결 시도
        def connect_device(mgr):
            loop = asyncio.new_event_loop()
            mgr.loop = loop
            asyncio.set_event_loop(loop)
            try:
                loop.create_task(mgr.run_forever())
                loop.run_forever()
            except Exception as e:
                logger.error(f"Failed to auto-connect {mgr.name}: {e}")
            finally:
                pending = asyncio.all_tasks(loop=loop)
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.close()
                mgr.loop = None
        
        Thread(target=connect_device, args=(manager,), daemon=True).start()
    
    logger.info(f"Loaded {len(rows)} devices from database")


class DeviceManager:
    """ESP32 BLE 디바이스 연결 및 데이터 수신 관리"""
    
    def __init__(self, device_id, address, name):
        self.device_id = device_id
        self.address = address
        self.name = name
        self.client = None
        self.connected = False
        self.last_data = None
        self.reconnect_task = None
        self.loop = None
        self._stop_requested = False
        
    async def notification_handler(self, sender, data):
        """BLE 알림 수신 핸들러"""
        try:
            text = data.decode('utf-8', errors='replace')
            logger.info(f"[{self.device_id}] Received: {text}")
            
            # 데이터 파싱
            match = EXT_PAYLOAD_RE.match(text)
            if match:
                # 직원 정보 조회
                employee_name = None
                conn = sqlite3.connect('strap_monitor.db')
                c = conn.cursor()
                c.execute('SELECT name FROM employees WHERE device_id = ?', (self.device_id,))
                row = c.fetchone()
                if row:
                    employee_name = row[0]
                conn.close()
                
                parsed_data = {
                    'device_id': self.device_id,
                    'employee_name': employee_name,
                    'timestamp': datetime.now().isoformat(),
                    'distance': match.group('dist'),
                    'raw': int(match.group('raw')),
                    'avg': int(match.group('avg')),
                    'diff': int(match.group('diff')),
                    'state': match.group('state'),
                }
                self.last_data = parsed_data

                # 글로벌 캐시에 최근 데이터 반영 (프론트엔드 목록 동기화용)
                with devices_lock:
                    entry = registered_devices.get(self.device_id)
                    if isinstance(entry, dict):
                        entry['last_data'] = parsed_data
                        entry['connected'] = True
                
                # 이벤트 로그 기록
                self._log_sensor_data(parsed_data)
                self._check_state_change(parsed_data)
                
                # WebSocket으로 프론트엔드에 전송
                socketio.emit('device_data', parsed_data, namespace='/')
                
        except Exception as e:
            logger.error(f"[{self.device_id}] Notification error: {e}")
    
    async def apply_current_policy(self):
        """현재 설정된 착용 정책을 디바이스에 적용"""
        try:
            command = build_policy_command(get_wear_policy())
            await self.send_command(command)
            logger.info(f"[{self.device_id}] Wear policy applied: {command}")
        except Exception as exc:
            logger.error(f"[{self.device_id}] Failed to apply wear policy: {exc}")

    def _log_sensor_data(self, data):
        """센서 데이터 로그 저장 (10초마다 샘플링)"""
        if not hasattr(self, '_last_log_time'):
            self._last_log_time = 0
        
        now = time.time()
        if now - self._last_log_time >= 10:  # 10초마다 저장
            self._last_log_time = now
            try:
                conn = sqlite3.connect('strap_monitor.db')
                c = conn.cursor()
                c.execute('''INSERT INTO sensor_data 
                    (device_id, distance, raw_hall, avg_hall, diff_hall, state)
                    VALUES (?, ?, ?, ?, ?, ?)''',
                    (self.device_id, 
                     None if data['distance'] == 'ERR' else int(data['distance']),
                     data['raw'], data['avg'], data['diff'], data['state']))
                conn.commit()
                conn.close()
            except Exception as e:
                logger.error(f"Failed to log sensor data: {e}")
    
    def _check_state_change(self, data):
        """착용 상태 변경 감지 및 로그"""
        if not hasattr(self, '_last_state'):
            self._last_state = None
        
        current_state = data['state']
        if self._last_state != current_state:
            # 상태 변경됨
            event_type = 'wear_on' if current_state == 'CLOSED' else 'wear_off'
            severity = 'info' if current_state == 'CLOSED' else 'warning'
            
            # 이벤트 로그 저장
            try:
                conn = sqlite3.connect('strap_monitor.db')
                c = conn.cursor()
                
                # 직원 ID 조회
                c.execute('SELECT id FROM employees WHERE device_id = ?', (self.device_id,))
                row = c.fetchone()
                employee_id = row[0] if row else None
                
                # 이벤트 로그
                c.execute('''INSERT INTO event_logs 
                    (device_id, employee_id, event_type, event_data, severity)
                    VALUES (?, ?, ?, ?, ?)''',
                    (self.device_id, employee_id, event_type, 
                     json.dumps(data), severity))
                
                # 착용 세션 관리
                if current_state == 'CLOSED':
                    # 새 세션 시작
                    c.execute('''INSERT INTO wear_sessions 
                        (device_id, employee_id, start_time)
                        VALUES (?, ?, ?)''',
                        (self.device_id, employee_id, datetime.now()))
                else:
                    # 기존 세션 종료
                    c.execute('''UPDATE wear_sessions 
                        SET end_time = ?, is_active = 0,
                            duration_seconds = CAST((julianday(?) - julianday(start_time)) * 86400 AS INTEGER)
                        WHERE device_id = ? AND is_active = 1''',
                        (datetime.now(), datetime.now(), self.device_id))
                
                conn.commit()
                conn.close()
                
                # WebSocket으로 이벤트 전송
                socketio.emit('state_change', {
                    'device_id': self.device_id,
                    'employee_id': employee_id,
                    'old_state': self._last_state,
                    'new_state': current_state,
                    'timestamp': datetime.now().isoformat()
                }, namespace='/')
                
            except Exception as e:
                logger.error(f"Failed to log state change: {e}")
            
            self._last_state = current_state
    
    async def run_forever(self):
        """지속적으로 연결을 유지하며 필요 시 재시도"""
        backoff_seconds = 3
        self._stop_requested = False
        while not self._stop_requested:
            try:
                await self.connect()
            except Exception as exc:
                logger.error(f"[{self.device_id}] Run loop error: {exc}")
            if self._stop_requested:
                break
            # 연결이 종료된 경우 잠시 대기 후 재시도
            if self._stop_requested:
                break
            await asyncio.sleep(backoff_seconds)

    def request_stop(self):
        """백그라운드 루프 정지 요청"""
        self._stop_requested = True
        self.connected = False
        with devices_lock:
            entry = registered_devices.get(self.device_id)
            if isinstance(entry, dict):
                entry['connected'] = False
        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(self.loop.stop)

    async def connect(self):
        """디바이스 연결 (재연결 로직 포함)"""
        max_retries = 3
        retry_delay = 5  # 초
        
        for attempt in range(max_retries):
            if self._stop_requested:
                break
            try:
                # 연결 시도 상태 전송
                socketio.emit('device_status', {
                    'device_id': self.device_id,
                    'status': 'connecting',
                    'message': f'연결 시도 중... ({attempt + 1}/{max_retries})',
                    'timestamp': get_kst_now().isoformat()
                }, namespace='/')
                
                logger.info(f"[{self.device_id}] Connecting to {self.address}... (Attempt {attempt + 1}/{max_retries})")
                self.client = BleakClient(self.address, timeout=15.0)
                
                # BLE 스캔 및 연결
                socketio.emit('device_status', {
                    'device_id': self.device_id,
                    'status': 'connecting',
                    'message': 'BLE 디바이스 검색 중...',
                    'timestamp': get_kst_now().isoformat()
                }, namespace='/')
                
                await self.client.connect()
                self.connected = True

                with devices_lock:
                    entry = registered_devices.get(self.device_id)
                    if isinstance(entry, dict):
                        entry['connected'] = True
                
                # 연결 성공 상태 전송
                socketio.emit('device_status', {
                    'device_id': self.device_id,
                    'status': 'connected',
                    'message': '연결 성공! 알림 구독 중...',
                    'timestamp': get_kst_now().isoformat()
                }, namespace='/')
                
                # DB에 마지막 연결 시간 업데이트
                try:
                    conn = sqlite3.connect('strap_monitor.db')
                    c = conn.cursor()
                    c.execute('UPDATE devices SET last_connected = ? WHERE id = ?',
                              (get_kst_now().isoformat(), self.device_id))
                    conn.commit()
                    conn.close()
                except Exception as e:
                    logger.error(f"Failed to update last_connected: {e}")
                
                logger.info(f"[{self.device_id}] Connected! Subscribing to notifications...")
                await self.client.start_notify(STRAP_NOTIFY_UUID, self.notification_handler)

                # 최신 착용 정책 적용
                await self.apply_current_policy()
                
                # 연결 완료 상태 알림
                socketio.emit('device_connected', {
                    'device_id': self.device_id,
                    'address': self.address,
                    'name': self.name
                }, namespace='/')
                
                socketio.emit('device_status', {
                    'device_id': self.device_id,
                    'status': 'ready',
                    'message': '정상 작동 중',
                    'timestamp': get_kst_now().isoformat()
                }, namespace='/')
                
                # 연결 유지 및 상태 모니터링
                reconnect_needed = False
                while self.connected:
                    if not self.client.is_connected:
                        reconnect_needed = True
                        self.connected = False
                        with devices_lock:
                            entry = registered_devices.get(self.device_id)
                            if isinstance(entry, dict):
                                entry['connected'] = False
                        logger.warning(f"[{self.device_id}] Connection lost, attempting reconnect...")
                        socketio.emit('device_status', {
                            'device_id': self.device_id,
                            'status': 'disconnected',
                            'message': '연결 끊김 - 재연결 시도 중...',
                            'timestamp': get_kst_now().isoformat()
                        }, namespace='/')
                        break
                    await asyncio.sleep(1)
                    
                # 연결이 끊어진 경우 자동 재연결 시도
                if reconnect_needed:
                    logger.info(f"[{self.device_id}] Auto-reconnecting in {retry_delay}s...")
                    socketio.emit('device_status', {
                        'device_id': self.device_id,
                        'status': 'reconnecting',
                        'message': f'{retry_delay}초 후 자동 재연결...',
                        'timestamp': get_kst_now().isoformat()
                    }, namespace='/')
                    if self._stop_requested:
                        break
                    await asyncio.sleep(retry_delay)
                    continue  # 재연결 시도
                else:
                    break  # 수동 종료
                    
            except asyncio.TimeoutError:
                if self._stop_requested:
                    break
                error_msg = f"연결 시간 초과 (15초)"
                logger.error(f"[{self.device_id}] {error_msg}")
                self.connected = False
                with devices_lock:
                    entry = registered_devices.get(self.device_id)
                    if isinstance(entry, dict):
                        entry['connected'] = False
                
                socketio.emit('device_status', {
                    'device_id': self.device_id,
                    'status': 'error',
                    'message': f'❌ {error_msg}',
                    'timestamp': get_kst_now().isoformat()
                }, namespace='/')
                
                if attempt < max_retries - 1:
                    logger.info(f"[{self.device_id}] Retrying in {retry_delay}s...")
                    if self._stop_requested:
                        break
                    await asyncio.sleep(retry_delay)
                else:
                    socketio.emit('device_disconnected', {
                        'device_id': self.device_id,
                        'error': error_msg
                    }, namespace='/')
                    break
                    
            except Exception as e:
                error_msg = str(e)
                logger.error(f"[{self.device_id}] Connection error (Attempt {attempt + 1}): {e}")
                self.connected = False
                with devices_lock:
                    entry = registered_devices.get(self.device_id)
                    if isinstance(entry, dict):
                        entry['connected'] = False
                if self._stop_requested:
                    break
                
                # 상세한 에러 메시지
                if "not found" in error_msg.lower():
                    error_msg = "디바이스를 찾을 수 없습니다. 전원과 거리를 확인하세요."
                elif "permission" in error_msg.lower():
                    error_msg = "권한 오류. 블루투스 권한을 확인하세요."
                elif "already connected" in error_msg.lower():
                    error_msg = "이미 다른 곳에 연결되어 있습니다."
                else:
                    error_msg = f"연결 실패: {error_msg}"
                
                socketio.emit('device_status', {
                    'device_id': self.device_id,
                    'status': 'error',
                    'message': f'❌ {error_msg}',
                    'timestamp': get_kst_now().isoformat()
                }, namespace='/')
                
                if attempt < max_retries - 1:
                    logger.info(f"[{self.device_id}] Retrying in {retry_delay}s...")
                    if self._stop_requested:
                        break
                    await asyncio.sleep(retry_delay)
                else:
                    socketio.emit('device_disconnected', {
                        'device_id': self.device_id,
                        'error': error_msg
                    }, namespace='/')
                    break
        
        await self.disconnect()
    
    async def disconnect(self):
        """디바이스 연결 해제"""
        self.connected = False
        with devices_lock:
            entry = registered_devices.get(self.device_id)
            if isinstance(entry, dict):
                entry['connected'] = False
        if self.client:
            try:
                await self.client.stop_notify(STRAP_NOTIFY_UUID)
                await self.client.disconnect()
            except Exception as e:
                logger.error(f"[{self.device_id}] Disconnect error: {e}")
            finally:
                self.client = None
    
    async def send_command(self, command):
        """디바이스에 명령 전송"""
        if not self.client or not self.connected:
            raise Exception("Device not connected")
        
        try:
            await self.client.write_gatt_char(
                STRAP_WRITE_UUID, 
                command.encode('utf-8'), 
                response=True
            )
            logger.info(f"[{self.device_id}] Sent command: {command}")
            return True
        except Exception as e:
            logger.error(f"[{self.device_id}] Command error: {e}")
            raise


# ============= 공통 유틸리티 =============

def _resolve_manager(device_id):
    with devices_lock:
        device = registered_devices.get(device_id)
        if not device:
            return None, None
        return device, device.get('manager')


def _dispatch_ble_command(manager, command, timeout=10):
    loop = getattr(manager, 'loop', None)
    if not loop or not loop.is_running():
        raise RuntimeError('loop_inactive')

    future = asyncio.run_coroutine_threadsafe(manager.send_command(command), loop)
    try:
        future.result(timeout=timeout)
        return True
    except concurrent.futures.TimeoutError as exc:
        future.cancel()
        raise TimeoutError('timeout') from exc
    except Exception as exc:
        raise RuntimeError(str(exc)) from exc


def _coerce_int(value, default=None):
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _send_command_response(manager, command, extra=None):
    try:
        _dispatch_ble_command(manager, command)
        payload = {'success': True, 'command': command}
        if isinstance(extra, dict):
            payload.update(extra)
        return jsonify(payload)
    except TimeoutError:
        return jsonify({'error': '명령 전송 시간이 초과되었습니다.'}), 504
    except Exception as exc:
        message = str(exc)
        if message == 'loop_inactive':
            return jsonify({'error': '디바이스 연결 루프가 활성화되지 않았습니다.'}), 503
        return jsonify({'error': message}), 500


def _clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


# ============= 인증 데코레이터 =============

def login_required(f):
    """로그인 필요 데코레이터"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function


# ============= 인증 API =============

@app.route('/login', methods=['GET'])
def login():
    """로그인 페이지"""
    if 'user_id' in session:
        return redirect('/admin')
    return render_template('login.html')


@app.route('/api/login', methods=['POST'])
def api_login():
    """로그인 처리"""
    data = request.json
    username = data.get('username')
    password = data.get('password')
    
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    
    # 비밀번호 해싱
    password_hash = hashlib.sha256(password.encode()).hexdigest()
    
    # DB에서 사용자 확인
    conn = sqlite3.connect('strap_monitor.db')
    c = conn.cursor()
    c.execute('SELECT id, username, role FROM users WHERE username = ? AND password_hash = ?',
              (username, password_hash))
    user = c.fetchone()
    conn.close()
    
    if user:
        session.permanent = True
        session['user_id'] = user[0]
        session['username'] = user[1]
        session['role'] = user[2]
        return jsonify({
            'success': True,
            'username': user[1],
            'role': user[2]
        })
    else:
        return jsonify({'error': 'Invalid username or password'}), 401


@app.route('/api/logout', methods=['POST'])
def api_logout():
    """로그아웃"""
    session.clear()
    return jsonify({'success': True})


# ============= REST API 엔드포인트 =============

@app.route('/')
def index():
    """메인 페이지 - 로그인 또는 대시보드"""
    if 'user_id' not in session:
        return redirect('/login')
    return redirect('/admin')


@app.route('/admin')
@login_required
def admin():
    """관리자 대시보드"""
    return render_template('admin.html')


@app.route('/test')
@login_required
def test_page():
    """새로운 테스트 대시보드"""
    return render_template('test.html')


@app.route('/api/health', methods=['GET'])
def health_check():
    """서버 상태 확인"""
    return jsonify({'status': 'ok', 'timestamp': datetime.now().isoformat()})


@app.route('/api/scan', methods=['POST'])
@login_required
def scan_devices():
    """BLE 디바이스 스캔"""
    global scanning
    
    if scanning:
        return jsonify({'error': 'Scan already in progress'}), 409
    
    timeout = request.json.get('timeout', 5.0) if request.json else 5.0
    
    async def do_scan():
        global scanning
        scanning = True
        try:
            logger.info(f"Starting BLE scan (timeout={timeout}s)...")
            devices = await BleakScanner.discover(timeout=timeout)
            
            results = []
            for device in devices:
                # ESP32-STRAP 디바이스만 필터링 (옵션)
                if device.name and 'ESP32' in device.name:
                    results.append({
                        'address': device.address,
                        'name': device.name or 'Unknown',
                        'rssi': getattr(device, 'rssi', None)
                    })
            
            logger.info(f"Scan complete. Found {len(results)} ESP32 devices")
            socketio.emit('scan_complete', {'devices': results}, namespace='/')
            
            return results
        finally:
            scanning = False
    
    # 비동기 스캔 실행
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    results = loop.run_until_complete(do_scan())
    loop.close()
    
    return jsonify({'devices': results})


@app.route('/api/devices', methods=['GET'])
def get_devices():
    """등록된 디바이스 목록 조회"""
    conn = sqlite3.connect('strap_monitor.db')
    c = conn.cursor()

    with devices_lock:
        device_list = []
        for device_id, device in registered_devices.items():
            employee_name = None
            try:
                c.execute('SELECT name FROM employees WHERE device_id = ?', (device_id,))
                row = c.fetchone()
                if row:
                    employee_name = row[0]
            except Exception as exc:
                logger.error(f"Failed to fetch employee for {device_id}: {exc}")

            manager = device.get('manager')
            last_data = device.get('last_data') or (manager.last_data if manager else None)
            if last_data and employee_name and not last_data.get('employee_name'):
                last_data = dict(last_data)
                last_data['employee_name'] = employee_name

            device_list.append({
                'id': device_id,
                'address': device['address'],
                'name': device['name'],
                'connected': device.get('connected', manager.connected if manager else False),
                'employee_name': employee_name,
                'last_data': last_data
            })

    conn.close()
    return jsonify({'devices': device_list})


@app.route('/api/devices/register', methods=['POST'])
def register_device():
    """새 디바이스 등록 및 연결"""
    data = request.json
    address = data.get('address')
    name = data.get('name', 'Unknown')
    
    if not address:
        return jsonify({'error': 'Address required'}), 400
    
    device_id = address.replace(':', '_')
    
    with devices_lock:
        if device_id in registered_devices:
            return jsonify({'error': 'Device already registered'}), 409
        
        # DeviceManager 생성
        manager = DeviceManager(device_id, address, name)
        
        registered_devices[device_id] = {
            'address': address,
            'name': name,
            'manager': manager,
            'connected': False,
            'last_data': None
        }
    
    # DB에 저장
    try:
        conn = sqlite3.connect('strap_monitor.db')
        c = conn.cursor()
        c.execute('''INSERT OR REPLACE INTO devices (id, address, name, registered_at)
                     VALUES (?, ?, ?, ?)''',
                  (device_id, address, name, datetime.now().isoformat()))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Failed to save device to DB: {e}")
    
    # 백그라운드에서 연결 시작
    def connect_in_thread():
        loop = asyncio.new_event_loop()
        manager.loop = loop
        asyncio.set_event_loop(loop)
        try:
            loop.create_task(manager.run_forever())
            loop.run_forever()
        except Exception as exc:
            logger.error(f"Failed to connect {manager.device_id}: {exc}")
        finally:
            pending = asyncio.all_tasks(loop=loop)
            for task in pending:
                task.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()
            manager.loop = None
    
    Thread(target=connect_in_thread, daemon=True).start()
    
    return jsonify({
        'message': 'Device registered and connecting',
        'device_id': device_id
    })


@app.route('/api/devices/<device_id>', methods=['DELETE'])
def unregister_device(device_id):
    """디바이스 등록 해제"""
    with devices_lock:
        if device_id not in registered_devices:
            return jsonify({'error': 'Device not found'}), 404
        
        device = registered_devices[device_id]
        manager = device.get('manager')
        
        if manager:
            loop = getattr(manager, 'loop', None)
            if loop and loop.is_running():
                try:
                    future = asyncio.run_coroutine_threadsafe(manager.disconnect(), loop)
                    future.result(timeout=10)
                except Exception as exc:
                    logger.error(f"Disconnect failed for {device_id}: {exc}")
                finally:
                    manager.request_stop()
            else:
                # 루프가 비활성화된 경우 직접 상태 초기화
                try:
                    asyncio.run(manager.disconnect())
                except RuntimeError:
                    pass
                manager.connected = False
        
        del registered_devices[device_id]
    
    # DB에서 삭제
    try:
        conn = sqlite3.connect('strap_monitor.db')
        c = conn.cursor()
        c.execute('DELETE FROM devices WHERE id = ?', (device_id,))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error(f"Failed to delete device from DB: {e}")
    
    return jsonify({'message': 'Device unregistered'})


@app.route('/api/devices/<device_id>/command', methods=['POST'])
def send_device_command(device_id):
    """디바이스에 명령 전송"""
    device, manager = _resolve_manager(device_id)
    if not device:
        return jsonify({'error': 'Device not found'}), 404
    if not manager:
        return jsonify({'error': 'Device manager not initialized'}), 500

    command = request.json.get('command')
    if not command:
        return jsonify({'error': 'Command required'}), 400
    return _send_command_response(manager, command, {'message': 'Command sent'})


@app.route('/api/devices/<device_id>/relay', methods=['POST'])
@login_required
def api_control_relay(device_id):
    device, manager = _resolve_manager(device_id)
    if not device:
        return jsonify({'error': 'Device not found'}), 404
    if not manager:
        return jsonify({'error': 'Device manager not initialized'}), 500

    payload = request.json or {}
    mode = str(payload.get('mode') or payload.get('state') or '').strip().lower()
    if mode not in {'on', 'off', 'pulse'}:
        return jsonify({'error': 'mode 값은 on, off, pulse 중 하나여야 합니다.'}), 400

    if mode == 'on':
        command = 'RELAY:ON'
    elif mode == 'off':
        command = 'RELAY:OFF'
    else:
        duration = _coerce_int(payload.get('duration_ms'), None)
        if duration is None:
            duration = _coerce_int(payload.get('duration'), None)
        if duration is None:
            duration = _coerce_int(payload.get('pulse_ms'), 200)
        duration = _clamp(duration or 200, 20, 5000)
        command = f'RELAY:PULSE:{duration}'

    return _send_command_response(manager, command, {
        'message': 'Relay command dispatched',
        'target': 'relay',
        'mode': mode
    })


@app.route('/api/devices/<device_id>/buzzer', methods=['POST'])
@login_required
def api_control_buzzer(device_id):
    device, manager = _resolve_manager(device_id)
    if not device:
        return jsonify({'error': 'Device not found'}), 404
    if not manager:
        return jsonify({'error': 'Device manager not initialized'}), 500

    payload = request.json or {}
    mode = str(payload.get('mode') or payload.get('state') or 'beep').strip().lower()
    if mode not in {'on', 'off', 'pulse', 'beep'}:
        return jsonify({'error': 'mode 값은 on, off, pulse, beep 중 하나여야 합니다.'}), 400

    freq = _coerce_int(payload.get('frequency_hz'), None)
    if freq is None:
        freq = _coerce_int(payload.get('freq'), None)
    if freq is not None:
        freq = _clamp(freq, 100, 8000)

    if mode == 'on':
        command = f'BUZZER:ON:{freq}' if freq else 'BUZZER:ON'
    elif mode == 'off':
        command = 'BUZZER:OFF'
    elif mode == 'beep':
        command = 'BEEP'
    else:
        duration = _coerce_int(payload.get('duration_ms'), None)
        if duration is None:
            duration = _coerce_int(payload.get('duration'), 180)
        duration = _clamp(duration or 180, 20, 4000)
        if freq:
            command = f'BUZZER:PULSE:{duration}:{freq}'
        else:
            command = f'BUZZER:PULSE:{duration}'

    extra = {'message': 'Buzzer command dispatched', 'target': 'buzzer', 'mode': mode}
    if freq:
        extra['frequency_hz'] = freq
    return _send_command_response(manager, command, extra)


@app.route('/api/devices/<device_id>/gpio', methods=['POST'])
@login_required
def api_control_gpio(device_id):
    device, manager = _resolve_manager(device_id)
    if not device:
        return jsonify({'error': 'Device not found'}), 404
    if not manager:
        return jsonify({'error': 'Device manager not initialized'}), 500

    payload = request.json or {}
    pin = _coerce_int(payload.get('pin'), None)
    if pin is None:
        return jsonify({'error': 'pin 값이 필요합니다.'}), 400
    if pin < 0 or pin > 39:
        return jsonify({'error': '허용되지 않는 GPIO 번호입니다.'}), 400

    state_token = payload.get('state', payload.get('value'))
    if state_token is None:
        return jsonify({'error': 'state 값이 필요합니다.'}), 400

    state_norm = str(state_token).strip().lower()
    if state_norm in {'1', 'high', 'on', 'true'}:
        state_word = 'HIGH'
    elif state_norm in {'0', 'low', 'off', 'false'}:
        state_word = 'LOW'
    else:
        return jsonify({'error': 'state 값은 on/off 또는 high/low 여야 합니다.'}), 400

    duration = _coerce_int(payload.get('duration_ms'), None)
    if duration is None:
        duration = _coerce_int(payload.get('duration'), 0)
    duration = _clamp(duration or 0, 0, 10000)

    command = f'GPIO:{pin}:{state_word}'
    if duration > 0:
        command = f'{command}:{duration}'

    extra = {
        'message': 'GPIO command dispatched',
        'target': 'gpio',
        'pin': pin,
        'state': state_word
    }
    if duration > 0:
        extra['duration_ms'] = duration

    return _send_command_response(manager, command, extra)


@app.route('/api/devices/<device_id>/reconnect', methods=['POST'])
def reconnect_device(device_id):
    """디바이스 재연결 시도"""
    with devices_lock:
        if device_id not in registered_devices:
            return jsonify({'error': 'Device not found'}), 404
        
        device = registered_devices[device_id]
        manager = device.get('manager')
        if not manager:
            return jsonify({'error': 'Device manager not initialized'}), 500
    
    # 백그라운드에서 재연결 시도
    loop = getattr(manager, 'loop', None)
    if not loop or not loop.is_running():
        return jsonify({'error': '디바이스 연결 루프가 활성화되지 않았습니다.'}), 503

    def schedule_reconnect():
        async def do_reconnect():
            try:
                if manager.connected:
                    await manager.disconnect()
                # run_forever가 다시 연결을 시도하도록 잠시 대기
            except Exception as exc:
                logger.error(f"Reconnection failed for {device_id}: {exc}")

        asyncio.create_task(do_reconnect())

    loop.call_soon_threadsafe(schedule_reconnect)

    return jsonify({'message': 'Reconnection request accepted', 'device_id': device_id})


@app.route('/api/policy/wear', methods=['GET'])
@login_required
def api_get_wear_policy():
    """착용 판정 정책 조회"""
    return jsonify(get_wear_policy())


@app.route('/api/policy/wear', methods=['POST'])
@login_required
def api_update_wear_policy():
    """착용 판정 정책 수정"""
    payload = request.json or {}
    try:
        updated_policy = save_wear_policy(payload)
        target_count = broadcast_wear_policy(updated_policy)
        return jsonify({'success': True, 'policy': updated_policy, 'targets': target_count})
    except Exception as exc:
        logger.error(f"Failed to update wear policy: {exc}")
        return jsonify({'error': '정책 저장 중 오류가 발생했습니다.'}), 500


# ============= 직원 관리 API =============

@app.route('/api/employees', methods=['GET'])
def get_employees():
    """직원 목록 조회"""
    conn = sqlite3.connect('strap_monitor.db')
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute('SELECT * FROM employees ORDER BY created_at DESC')
    rows = c.fetchall()
    conn.close()
    
    employees = [dict(row) for row in rows]
    return jsonify({'employees': employees})


@app.route('/api/employees', methods=['POST'])
def create_employee():
    """직원 등록"""
    data = request.json
    required = ['name', 'employee_number']
    
    if not all(k in data for k in required):
        return jsonify({'error': 'Missing required fields'}), 400
    
    try:
        conn = sqlite3.connect('strap_monitor.db')
        c = conn.cursor()
        c.execute('''INSERT INTO employees 
            (name, employee_number, department, position, device_id)
            VALUES (?, ?, ?, ?, ?)''',
            (data['name'], data['employee_number'],
             data.get('department'), data.get('position'), data.get('device_id')))
        conn.commit()
        employee_id = c.lastrowid
        conn.close()
        
        return jsonify({'message': 'Employee created', 'id': employee_id})
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Employee number already exists'}), 409
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/employees/<int:employee_id>', methods=['PUT'])
def update_employee(employee_id):
    """직원 정보 수정"""
    data = request.json
    
    try:
        conn = sqlite3.connect('strap_monitor.db')
        c = conn.cursor()
        
        # 업데이트할 필드만 동적으로 구성
        fields = []
        values = []
        for key in ['name', 'employee_number', 'department', 'position', 'device_id']:
            if key in data:
                fields.append(f'{key} = ?')
                values.append(data[key])
        
        if not fields:
            return jsonify({'error': 'No fields to update'}), 400
        
        fields.append('updated_at = CURRENT_TIMESTAMP')
        values.append(employee_id)
        
        query = f"UPDATE employees SET {', '.join(fields)} WHERE id = ?"
        c.execute(query, values)
        conn.commit()
        
        if c.rowcount == 0:
            conn.close()
            return jsonify({'error': 'Employee not found'}), 404
        
        conn.close()
        return jsonify({'message': 'Employee updated'})
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Employee number already exists'}), 409
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/employees/<int:employee_id>', methods=['DELETE'])
def delete_employee(employee_id):
    """직원 삭제"""
    try:
        conn = sqlite3.connect('strap_monitor.db')
        c = conn.cursor()
        c.execute('DELETE FROM employees WHERE id = ?', (employee_id,))
        conn.commit()
        
        if c.rowcount == 0:
            conn.close()
            return jsonify({'error': 'Employee not found'}), 404
        
        conn.close()
        return jsonify({'message': 'Employee deleted'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============= 로그 & 통계 API =============

@app.route('/api/logs/events', methods=['GET'])
def get_event_logs():
    """이벤트 로그 조회"""
    limit = request.args.get('limit', 100, type=int)
    event_type = request.args.get('type')
    severity = request.args.get('severity')
    
    conn = sqlite3.connect('strap_monitor.db')
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    query = '''SELECT el.*, e.name as employee_name 
               FROM event_logs el 
               LEFT JOIN employees e ON el.employee_id = e.id 
               WHERE 1=1'''
    params = []
    
    if event_type:
        query += ' AND el.event_type = ?'
        params.append(event_type)
    
    if severity:
        query += ' AND el.severity = ?'
        params.append(severity)
    
    query += ' ORDER BY el.timestamp DESC LIMIT ?'
    params.append(limit)
    
    c.execute(query, params)
    rows = c.fetchall()
    conn.close()
    
    logs = [dict(row) for row in rows]
    return jsonify({'logs': logs})


@app.route('/api/logs/wear-sessions', methods=['GET'])
def get_wear_sessions():
    """착용 세션 로그"""
    limit = request.args.get('limit', 50, type=int)
    active_only = request.args.get('active', 'false').lower() == 'true'
    
    conn = sqlite3.connect('strap_monitor.db')
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    query = '''SELECT ws.*, e.name as employee_name, e.employee_number
               FROM wear_sessions ws
               LEFT JOIN employees e ON ws.employee_id = e.id'''
    
    if active_only:
        query += ' WHERE ws.is_active = 1'
    
    query += ' ORDER BY ws.start_time DESC LIMIT ?'
    
    c.execute(query, (limit,))
    rows = c.fetchall()
    conn.close()
    
    sessions = [dict(row) for row in rows]
    return jsonify({'sessions': sessions})


@app.route('/api/stats/summary', methods=['GET'])
def get_stats_summary():
    """통계 요약"""
    conn = sqlite3.connect('strap_monitor.db')
    c = conn.cursor()
    
    # 총 직원 수
    c.execute('SELECT COUNT(*) FROM employees')
    total_employees = c.fetchone()[0]
    
    # 현재 착용 중인 직원 수
    c.execute('SELECT COUNT(*) FROM wear_sessions WHERE is_active = 1')
    currently_wearing = c.fetchone()[0]
    
    # 오늘 착용 해제 이벤트 수
    c.execute('''SELECT COUNT(*) FROM event_logs 
                 WHERE event_type = 'wear_off' 
                 AND date(timestamp) = date('now')''')
    today_unwear_count = c.fetchone()[0]
    
    # 총 이벤트 수
    c.execute('SELECT COUNT(*) FROM event_logs')
    total_events = c.fetchone()[0]
    
    conn.close()
    
    return jsonify({
        'total_employees': total_employees,
        'currently_wearing': currently_wearing,
        'today_unwear_events': today_unwear_count,
        'total_events': total_events
    })


@app.route('/api/stats/unwearing', methods=['GET'])
def get_unwearing_employees():
    """현재 미착용 직원 목록"""
    conn = sqlite3.connect('strap_monitor.db')
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    # 기기가 할당된 직원 중 현재 착용 중이 아닌 직원
    c.execute('''
        SELECT e.id, e.name, e.employee_number, e.department, e.device_id,
               (SELECT MAX(timestamp) FROM event_logs 
                WHERE device_id = e.device_id AND event_type = 'wear_off') as last_unwear_time
        FROM employees e
        WHERE e.device_id IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM wear_sessions ws 
            WHERE ws.employee_id = e.id AND ws.is_active = 1
        )
    ''')
    
    rows = c.fetchall()
    conn.close()

    with devices_lock:
        connected_devices = {
            device_id for device_id, info in registered_devices.items()
            if info.get('manager') and info['manager'].connected
        }

    unwearing = []
    for row in rows:
        device_id = row['device_id']
        if not device_id or device_id not in connected_devices:
            continue

        unwearing.append({
            'id': row['id'],
            'name': row['name'],
            'employee_number': row['employee_number'],
            'department': row['department'],
            'device_id': device_id,
            'last_unwear_time': row['last_unwear_time']
        })

    return jsonify({'unwearing': unwearing})


@app.route('/api/system/reset-db', methods=['POST'])
@login_required
def api_reset_database():
    """시스템 데이터베이스 초기화"""
    payload = request.json or {}
    if not payload.get('confirm'):
        return jsonify({'error': '초기화를 확인해주세요.'}), 400

    with devices_lock:
        managers = [device.get('manager') for device in registered_devices.values() if device.get('manager')]

    for manager in managers:
        if not manager:
            continue
        loop = getattr(manager, 'loop', None)
        if loop and loop.is_running():
            try:
                future = asyncio.run_coroutine_threadsafe(manager.disconnect(), loop)
                future.result(timeout=10)
            except Exception as exc:
                logger.error(f"Failed to disconnect device {manager.device_id} during reset: {exc}")
            finally:
                manager.request_stop()
        else:
            try:
                asyncio.run(manager.disconnect())
            except RuntimeError:
                pass
            manager.connected = False

    with devices_lock:
        registered_devices.clear()

    try:
        if os.path.exists('strap_monitor.db'):
            os.remove('strap_monitor.db')
    except OSError as exc:
        logger.error(f"Failed to remove database file: {exc}")
        return jsonify({'error': '데이터베이스 파일을 삭제할 수 없습니다.'}), 500

    init_db()
    socketio.emit('system_reset', {
        'timestamp': get_kst_now().isoformat()
    }, namespace='/')

    return jsonify({'success': True})


# ============= WebSocket 이벤트 =============

@socketio.on('connect')
def handle_connect():
    """클라이언트 연결"""
    logger.info(f"Client connected: {request.sid}")
    emit('connected', {'message': 'Connected to BLE Monitor Server'})


@socketio.on('disconnect')
def handle_disconnect():
    """클라이언트 연결 해제"""
    logger.info(f"Client disconnected: {request.sid}")


@socketio.on('request_scan')
def handle_scan_request(data):
    """스캔 요청 (WebSocket)"""
    timeout = data.get('timeout', 5.0) if data else 5.0
    
    # REST API 재사용
    scan_devices()


if __name__ == '__main__':
    logger.info("Starting BLE Strap Monitor Backend...")
    logger.info("Admin Dashboard: http://localhost:5000/admin")
    
    # DB에서 등록된 기기 자동 로드
    load_devices_from_db()
    
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, use_reloader=False, allow_unsafe_werkzeug=True)
