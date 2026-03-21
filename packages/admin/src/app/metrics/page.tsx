'use client';

import { Button } from '@knative-next/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@knative-next/ui/components/ui/card';
import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface MetricDataPoint {
  time: number;
  value: number;
}

export default function MetricsPage() {
  const [mockData, setMockData] = useState<MetricDataPoint[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadData = () => {
    setIsRefreshing(true);
    // We will call the API here eventually, utilizing /api/prometheus?query=...
    // For visualizing the UI, we generate a mock time series
    const now = Date.now();
    const data = Array.from({ length: 20 }).map((_, i) => ({
      time: now - (20 - i) * 60000, // Last 20 minutes
      value: Math.floor(Math.random() * 100) + 10, // Mock RPS
    }));

    setTimeout(() => {
      setMockData(data);
      setIsRefreshing(false);
    }, 500);
  };

  useEffect(() => {
    loadData();
  }, [loadData]);

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 bg-black min-h-screen">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-teal-400">
            Platform Metrics
          </h1>
          <p className="text-gray-400 mt-2">Time-series data from Prometheus</p>
        </div>
        <Button
          onClick={loadData}
          disabled={isRefreshing}
          className="bg-gray-800 hover:bg-gray-700 text-white border border-gray-700"
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader>
            <CardTitle className="text-white">API Requests (RPS)</CardTitle>
            <CardDescription className="text-gray-400">
              sum(rate(http_requests_total[5m]))
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full text-white">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={mockData}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis
                    dataKey="time"
                    tickFormatter={(unixTime) =>
                      new Date(unixTime).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    }
                    stroke="#9ca3af"
                  />
                  <YAxis stroke="#9ca3af" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#111827',
                      borderColor: '#374151',
                      color: '#fff',
                    }}
                    labelFormatter={(unixTime) => new Date(unixTime as number).toLocaleTimeString()}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorValue)"
                    animationDuration={1000}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Additional charts could go here, like CPU, Memory, Knative Scale state etc. */}
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader>
            <CardTitle className="text-white">Knative Active Replicas</CardTitle>
            <CardDescription className="text-gray-400">sum(autoscaler_actual_pods)</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-center h-[300px]">
            <p className="text-gray-500 italic">Waiting for Knative metric proxy integration...</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
