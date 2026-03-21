import { Button } from '@knative-next/ui/components/ui/button';

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-black text-white p-8">
      <div className="max-w-4xl w-full space-y-8">
        <div className="text-center space-y-4">
          <h1 className="text-5xl font-extrabold tracking-tight lg:text-6xl text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-600">
            kn-next Observability
          </h1>
          <p className="text-xl text-gray-400">Platform Admin Dashboard</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
          <div className="p-6 border border-gray-800 rounded-xl bg-gray-900/50 hover:bg-gray-800/50 transition-colors">
            <h3 className="text-xl font-bold mb-2">Metrics</h3>
            <p className="text-gray-400 mb-4">Prometheus time-series and resource utilization.</p>
            <Button variant="secondary" className="w-full">
              View Metrics
            </Button>
          </div>

          <div className="p-6 border border-gray-800 rounded-xl bg-gray-900/50 hover:bg-gray-800/50 transition-colors">
            <h3 className="text-xl font-bold mb-2">Logs</h3>
            <p className="text-gray-400 mb-4">Live streaming pod logs across Knative services.</p>
            <Button variant="secondary" className="w-full">
              Stream Logs
            </Button>
          </div>

          <div className="p-6 border border-gray-800 rounded-xl bg-gray-900/50 hover:bg-gray-800/50 transition-colors">
            <h3 className="text-xl font-bold mb-2">Load Tests</h3>
            <p className="text-gray-400 mb-4">Execute K6 load scenarios and monitor latency.</p>
            <Button variant="secondary" className="w-full">
              Run Load Tests
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
