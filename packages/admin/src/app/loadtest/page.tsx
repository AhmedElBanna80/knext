'use client';

import { Button } from '@knative-next/ui/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@knative-next/ui/components/ui/card';
import { useState } from 'react';

export default function LoadTestPage() {
  const [targetUrl, setTargetUrl] = useState('http://file-manager.default.svc.cluster.local');
  const [status, setStatus] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const runTest = async (type: string) => {
    setIsLoading(true);
    setStatus('Dispatching job to Kubernetes...');

    try {
      const res = await fetch('/api/loadtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl, type }),
      });

      const data = await res.json();

      if (res.ok) {
        setStatus(`Success: ${data.message}`);
      } else {
        setStatus(`Error: ${data.error} - ${data.details}`);
      }
    } catch (_e) {
      setStatus('Network error occurred communicating with admin backend.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 bg-black min-h-screen text-white">
      <div className="flex justify-between items-center border-b border-gray-800 pb-4">
        <div>
          <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-red-400 to-orange-600">
            K6 Load Testing Engine
          </h1>
          <p className="text-gray-400 mt-2">Trigger distributed load tests as Kubernetes Jobs</p>
        </div>
      </div>

      <Card className="bg-gray-900 border-gray-800 max-w-3xl">
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription className="text-gray-400">
            Specify the target URL to bombard
          </CardDescription>
        </CardHeader>
        <CardContent>
          <input
            type="text"
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="http://my-service.default.svc..."
            className="flex h-10 w-full rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 bg-gray-800 border border-gray-700 text-white"
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="bg-gray-900 border-gray-800 hover:border-gray-600 transition-colors">
          <CardHeader>
            <CardTitle>Smoke Test</CardTitle>
            <CardDescription className="text-gray-400">
              1 VU for 1 minute. Validates basic system health.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="secondary"
              disabled={isLoading}
              onClick={() => runTest('smoke')}
              className="w-full"
            >
              Trigger Smoke Test
            </Button>
          </CardContent>
        </Card>

        <Card className="bg-gray-900 border-gray-800 hover:border-gray-600 transition-colors">
          <CardHeader>
            <CardTitle>Load Test</CardTitle>
            <CardDescription className="text-gray-400">
              Scales to 50 VUs over 3m. Simulates normal traffic patterns.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="secondary"
              disabled={isLoading}
              onClick={() => runTest('load')}
              className="w-full"
            >
              Trigger Load Test
            </Button>
          </CardContent>
        </Card>

        <Card className="bg-gray-900 border-gray-800 hover:border-gray-600 transition-colors">
          <CardHeader>
            <CardTitle>Spike Test</CardTitle>
            <CardDescription className="text-gray-400">
              Sudden burst to 200 VUs. Simulates aggressive viral traffic.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="secondary"
              disabled={isLoading}
              onClick={() => runTest('spike')}
              className="w-full bg-orange-600 hover:bg-orange-700 text-white"
            >
              Trigger Spike Test
            </Button>
          </CardContent>
        </Card>

        <Card className="bg-gray-900 border-gray-800 hover:border-gray-600 transition-colors">
          <CardHeader>
            <CardTitle>Scale-to-Zero Awakener</CardTitle>
            <CardDescription className="text-gray-400">
              Cold start evaluation. Hits Knative to trigger pod creation, waits, hits again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="secondary"
              disabled={isLoading}
              onClick={() => runTest('scale-to-zero')}
              className="w-full bg-purple-600 hover:bg-purple-700 text-white"
            >
              Trigger Scale-to-Zero Evaulation
            </Button>
          </CardContent>
        </Card>
      </div>

      {status && (
        <div className="p-4 rounded-md bg-gray-800 border border-gray-700 text-sm font-mono mt-8">
          {status}
        </div>
      )}
    </div>
  );
}
