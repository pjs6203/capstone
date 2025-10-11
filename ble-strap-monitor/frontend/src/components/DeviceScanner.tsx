import React, { useState } from 'react';
import { Socket } from 'socket.io-client';
import { Search, Plus, Loader2 } from 'lucide-react';

interface ScannedDevice {
  address: string;
  name: string;
  rssi?: number;
}

interface Props {
  socket: Socket | null;
  onDeviceRegistered: () => void;
}

export default function DeviceScanner({ socket, onDeviceRegistered }: Props) {
  const [scanning, setScanning] = useState(false);
  const [scannedDevices, setScannedDevices] = useState<ScannedDevice[]>([]);

  const startScan = async () => {
    setScanning(true);
    setScannedDevices([]);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeout: 5 }),
      });

      const data = await response.json();
      setScannedDevices(data.devices || []);
    } catch (error) {
      console.error('Scan failed:', error);
    } finally {
      setScanning(false);
    }
  };

  const registerDevice = async (device: ScannedDevice) => {
    try {
      await fetch('/api/devices/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: device.address,
          name: device.name,
        }),
      });

      onDeviceRegistered();
      // 등록 후 스캔 결과에서 제거
      setScannedDevices((prev) => prev.filter((d) => d.address !== device.address));
    } catch (error) {
      console.error('Failed to register device:', error);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
          <Search className="w-5 h-5" />
          디바이스 스캔
        </h2>
      </div>

      <button
        onClick={startScan}
        disabled={scanning}
        className="w-full bg-primary-500 hover:bg-primary-600 disabled:bg-gray-300 
                   text-white font-medium py-3 px-4 rounded-lg transition-colors
                   flex items-center justify-center gap-2"
      >
        {scanning ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            스캔 중...
          </>
        ) : (
          <>
            <Search className="w-5 h-5" />
            BLE 스캔 시작
          </>
        )}
      </button>

      {scannedDevices.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-gray-600 font-medium">
            발견된 디바이스 ({scannedDevices.length})
          </p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {scannedDevices.map((device) => (
              <div
                key={device.address}
                className="flex items-center justify-between p-3 bg-gray-50 
                           rounded-lg border border-gray-200 hover:border-primary-300 
                           transition-colors"
              >
                <div className="flex-1">
                  <p className="font-medium text-gray-900">{device.name}</p>
                  <p className="text-xs text-gray-500">{device.address}</p>
                  {device.rssi && (
                    <p className="text-xs text-gray-400">RSSI: {device.rssi} dBm</p>
                  )}
                </div>
                <button
                  onClick={() => registerDevice(device)}
                  className="ml-3 p-2 bg-green-500 hover:bg-green-600 text-white 
                             rounded-lg transition-colors"
                  title="등록"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {!scanning && scannedDevices.length === 0 && (
        <div className="mt-4 p-4 bg-gray-50 rounded-lg text-center">
          <p className="text-sm text-gray-500">
            스캔 버튼을 클릭하여 주변의 ESP32 디바이스를 검색하세요
          </p>
        </div>
      )}
    </div>
  );
}
