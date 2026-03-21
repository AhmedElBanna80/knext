import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { NextResponse } from 'next/server';

const execAsync = promisify(exec);

export async function POST(request: Request) {
  try {
    const { targetUrl, type } = await request.json();

    if (!targetUrl || !type) {
      return NextResponse.json({ error: 'targetUrl and type are required' }, { status: 400 });
    }

    // Ideally this would run the pure Node functions or use the K8s API directly.
    // For simplicity in the proxy API, we execute the CLI command we just built.
    const cmd = `bun run ../../packages/kn-next/src/cli/loadtest.ts --url ${targetUrl} --type ${type}`;

    console.log(`[Admin] Triggering load test: ${cmd}`);

    // Execute asynchronously, don't wait for completion because K6 Jobs can take minutes.
    // We just verify it successfully deploys to K8s.
    const { stdout } = await execAsync(cmd);

    return NextResponse.json({
      success: true,
      message: 'Load test job successfully dispatched to Kubernetes',
      output: stdout,
    });
  } catch (e: any) {
    console.error('Loadtest API error:', e);
    return NextResponse.json(
      {
        error: 'Failed to dispatch load test job',
        details: e.stderr || e.message,
      },
      { status: 500 },
    );
  }
}
