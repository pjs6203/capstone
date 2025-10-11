import React, { useState } from 'react';
import { Device } from '../App';
import { Trash2, Send, CheckCircle, XCircle, Clock } from 'lucide-react';

interface Props {
  devices: Device[];
  onRemoveDevice: (deviceId: string) => void;
  onSendCommand: (deviceId: string, command: string) => void;
}

export default function DeviceList({ devices, onRemoveDevice, onSendCommand }: Props) {
  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);

  const quickCommands = [
    { label: 'ONCE', command: 'ONCE', desc: '즉시 측정' },
    { label: 'CAL', command: 'CAL', desc: '재보정' },
    { label: 'BEEP', command: 'BEEP', desc: '테스트 비프' },
    { label: 'STATE', command: 'STATE', desc: '상태 확인' },
  ];

  return (
    <div className="bg-white rounded-xl shadow-lg p-6">
      <h2 className="text-xl font-bold text-gray-800 mb-4">
        등록된 디바이스 ({devices.length})
      </h2>

      {devices.length === 0 ? (
        <div className="p-8 text-center bg-gray-50 rounded-lg">
          <p className="text-gray-500">등록된 디바이스가 없습니다</p>
          <p className="text-sm text-gray-400 mt-1">
            위에서 디바이스를 스캔하고 등록하세요
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {devices.map((device) => (
            <div
              key={device.id}
              className="border border-gray-200 rounded-lg overflow-hidden
                         hover:border-primary-300 transition-colors"
            >
              {/* 디바이스 헤더 */}
              <div
                className="p-4 bg-gray-50 cursor-pointer"
                onClick={() =>
                  setExpandedDevice(
                    expandedDevice === device.id ? null : device.id
                  )
                }
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">
                        {device.name}
                      </h3>
                      {device.connected ? (
                        <CheckCircle className="w-4 h-4 text-green-500" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-500" />
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {device.address}
                    </p>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`${device.name}을(를) 삭제하시겠습니까?`)) {
                        onRemoveDevice(device.id);
                      }
                    }}
                    className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                    title="삭제"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* 최근 데이터 미리보기 */}
                {device.last_data && (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center gap-1">
                      <span className="text-gray-500">거리:</span>
                      <span className="font-medium">
                        {device.last_data.distance === 'ERR'
                          ? 'N/A'
                          : `${device.last_data.distance}mm`}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-500">상태:</span>
                      <span
                        className={`font-medium ${
                          device.last_data.state === 'CLOSED'
                            ? 'text-green-600'
                            : 'text-orange-600'
                        }`}
                      >
                        {device.last_data.state === 'CLOSED' ? '착용' : '미착용'}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* 확장 영역: 명령 버튼 */}
              {expandedDevice === device.id && device.connected && (
                <div className="p-4 bg-white border-t border-gray-200">
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    빠른 명령
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {quickCommands.map((cmd) => (
                      <button
                        key={cmd.command}
                        onClick={() => onSendCommand(device.id, cmd.command)}
                        className="flex items-center justify-center gap-2 px-3 py-2
                                   bg-primary-50 hover:bg-primary-100 text-primary-700
                                   rounded-lg text-sm font-medium transition-colors"
                        title={cmd.desc}
                      >
                        <Send className="w-3 h-3" />
                        {cmd.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
