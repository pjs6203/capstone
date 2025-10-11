import React from 'react';
import { Device, DeviceData } from '../App';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Activity, TrendingUp } from 'lucide-react';

interface Props {
  devices: Device[];
  deviceData: Map<string, DeviceData[]>;
}

export default function Dashboard({ devices, deviceData }: Props) {
  const connectedDevices = devices.filter((d) => d.connected);

  return (
    <div className="space-y-6">
      {/* 요약 카드 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 font-medium">총 디바이스</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">
                {devices.length}
              </p>
            </div>
            <div className="p-3 bg-blue-100 rounded-lg">
              <Activity className="w-8 h-8 text-blue-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 font-medium">연결됨</p>
              <p className="text-3xl font-bold text-green-600 mt-1">
                {connectedDevices.length}
              </p>
            </div>
            <div className="p-3 bg-green-100 rounded-lg">
              <TrendingUp className="w-8 h-8 text-green-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600 font-medium">착용 중</p>
              <p className="text-3xl font-bold text-purple-600 mt-1">
                {
                  devices.filter(
                    (d) => d.last_data?.state === 'CLOSED'
                  ).length
                }
              </p>
            </div>
            <div className="p-3 bg-purple-100 rounded-lg">
              <Activity className="w-8 h-8 text-purple-600" />
            </div>
          </div>
        </div>
      </div>

      {/* 실시간 차트 */}
      {connectedDevices.length > 0 ? (
        <div className="space-y-4">
          {connectedDevices.map((device) => {
            const data = deviceData.get(device.id) || [];
            
            // 차트 데이터 변환
            const chartData = data.slice(-50).map((d, idx) => ({
              index: idx,
              distance: d.distance === 'ERR' ? null : parseInt(d.distance),
              diff: d.diff,
              state: d.state === 'CLOSED' ? 1 : 0,
            }));

            return (
              <div
                key={device.id}
                className="bg-white rounded-xl shadow-lg p-6"
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold text-gray-800">
                    {device.name}
                  </h3>
                  {device.last_data && (
                    <div className="flex items-center gap-4 text-sm">
                      <div>
                        <span className="text-gray-600">거리: </span>
                        <span className="font-semibold">
                          {device.last_data.distance === 'ERR'
                            ? 'N/A'
                            : `${device.last_data.distance}mm`}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-600">상태: </span>
                        <span
                          className={`font-semibold ${
                            device.last_data.state === 'CLOSED'
                              ? 'text-green-600'
                              : 'text-orange-600'
                          }`}
                        >
                          {device.last_data.state === 'CLOSED'
                            ? '착용'
                            : '미착용'}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-600">홀센서 차이: </span>
                        <span className="font-semibold">
                          {device.last_data.diff}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        dataKey="index"
                        stroke="#9ca3af"
                        tick={{ fontSize: 12 }}
                      />
                      <YAxis stroke="#9ca3af" tick={{ fontSize: 12 }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#fff',
                          border: '1px solid #e5e7eb',
                          borderRadius: '8px',
                        }}
                      />
                      <Legend />
                      <Line
                        type="monotone"
                        dataKey="distance"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={false}
                        name="거리 (mm)"
                      />
                      <Line
                        type="monotone"
                        dataKey="diff"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        dot={false}
                        name="홀센서 차이"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-64 flex items-center justify-center bg-gray-50 rounded-lg">
                    <p className="text-gray-500">데이터 수신 대기 중...</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-lg p-12 text-center">
          <Activity className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-600 font-medium">
            연결된 디바이스가 없습니다
          </p>
          <p className="text-sm text-gray-400 mt-2">
            디바이스를 등록하고 연결하면 실시간 데이터를 볼 수 있습니다
          </p>
        </div>
      )}
    </div>
  );
}
