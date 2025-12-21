import { getDbPool } from '@knative-next/framework';

export const dynamic = 'force-dynamic';

async function getAuditLogs() {
  const db = getDbPool();
  // Simulate heavy read
  const res = await db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
  return res.rows;
}

export default async function AuditPage() {
  const logs = await getAuditLogs();

  return (
    <div className="p-8 text-white">
      <h1 className="text-3xl font-bold mb-8">Audit Logs</h1>
      <p className="mb-4 text-gray-400">Showing last 100 system events.</p>

      <div className="bg-white/5 rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-white/10">
            <tr>
              <th className="p-4">Time</th>
              <th className="p-4">Action</th>
              <th className="p-4">Details</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log: any) => (
              <tr key={log.id} className="border-t border-white/10 hover:bg-white/5">
                <td className="p-4 font-mono text-sm text-gray-300">
                  {new Date(log.created_at).toISOString()}
                </td>
                <td className="p-4">
                  <span
                    className={`px-2 py-1 rounded text-xs font-bold ${
                      log.action === 'LOGIN'
                        ? 'bg-green-500/20 text-green-200'
                        : 'bg-blue-500/20 text-blue-200'
                    }`}
                  >
                    {log.action}
                  </span>
                </td>
                <td className="p-4 text-gray-300">{log.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
