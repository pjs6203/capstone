import React, { useState, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import DeviceScanner from './components/DeviceScanner';
import DeviceList from './components/DeviceList';
import Dashboard from './components/Dashboard';
import { Bluetooth, Activity } from 'lucide-react';

export interface Device {
  id: string;
  address: string;
  name: string;
  connected: boolean;
  last_data?: DeviceData;
}

export interface DeviceData {
  device_id: string;
  timestamp: string;
  distance: string;
  raw: number;
  avg: number;
  diff: number;
  state: 'OPEN' | 'CLOSED';
}

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceData, setDeviceData] = useState<Map<string, DeviceData[]>>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // WebSocket 연결
    const newSocket = io('http://localhost:5000', {
      transports: ['websocket', 'polling'],
    });

    newSocket.on('connect', () => {
      console.log('Connected to server');
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Disconnected from server');
      setConnected(false);
    });

    // 디바이스 데이터 수신
    newSocket.on('device_data', (data: DeviceData) => {
      console.log('Received device data:', data);
      setDeviceData((prev) => {
        const newMap = new Map(prev);
        const deviceId = data.device_id;
        const existing = newMap.get(deviceId) || [];
        
        // 최근 100개 데이터만 유지
        const updated = [...existing, data].slice(-100);
        newMap.set(deviceId, updated);
        return newMap;
      });

      // 디바이스 목록의 last_data 업데이트
      setDevices((prev) =>
        prev.map((dev) =>
          dev.id === data.device_id ? { ...dev, last_data: data } : dev
        )
      );
    });

    // 디바이스 연결/해제 이벤트
    newSocket.on('device_connected', (data) => {
      console.log('Device connected:', data);
      fetchDevices();
    });

    newSocket.on('device_disconnected', (data) => {
      console.log('Device disconnected:', data);
      fetchDevices();
    });

    setSocket(newSocket);

    // 초기 디바이스 목록 로드
    fetchDevices();

    return () => {
      newSocket.close();
    };
  }, []);

  const fetchDevices = async () => {
    try {
      const response = await fetch('/api/devices');
      const data = await response.json();
      setDevices(data.devices);
    } catch (error) {
      console.error('Failed to fetch devices:', error);
    }
  };

  const handleDeviceRegistered = () => {
    fetchDevices();
  };

  const handleDeviceRemove = async (deviceId: string) => {
    try {
      await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' });
      fetchDevices();
      
      // 데이터 히스토리 제거
      setDeviceData((prev) => {
        const newMap = new Map(prev);
        newMap.delete(deviceId);
        return newMap;
      });
    } catch (error) {
      console.error('Failed to remove device:', error);
    }
  };

  const handleSendCommand = async (deviceId: string, command: string) => {
    try {
      await fetch(`/api/devices/${deviceId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } catch (error) {
      console.error('Failed to send command:', error);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50">
      {/* 헤더 */}
      <header className="bg-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary-500 rounded-lg">
                <Bluetooth className="w-8 h-8 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  BLE Strap Monitor
                </h1>
                <p className="text-sm text-gray-600">
                  ESP32 헬멧 스트랩 모니터링 시스템
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <div
                className={`flex items-center gap-2 px-4 py-2 rounded-full ${
                  connected
                    ? 'bg-green-100 text-green-700'
                    : 'bg-red-100 text-red-700'
                }`}
              >
                <Activity className="w-4 h-4" />
                <span className="text-sm font-medium">
                  {connected ? '연결됨' : '연결 끊김'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* 메인 컨텐츠 */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 왼쪽: 스캐너 + 디바이스 목록 */}
          <div className="lg:col-span-1 space-y-6">
            <DeviceScanner
              socket={socket}
              onDeviceRegistered={handleDeviceRegistered}
            />
            
            <DeviceList
              devices={devices}
              onRemoveDevice={handleDeviceRemove}
              onSendCommand={handleSendCommand}
            />
          </div>

          {/* 오른쪽: 대시보드 */}
          <div className="lg:col-span-2">
            <Dashboard devices={devices} deviceData={deviceData} />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
