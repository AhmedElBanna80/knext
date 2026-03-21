import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query');

  if (!query) {
    return NextResponse.json({ error: 'Missing PromQL query' }, { status: 400 });
  }

  const prometheusUrl =
    process.env.PROMETHEUS_URL || 'http://prometheus-server.default.svc.cluster.local:80';

  try {
    const response = await fetch(
      `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`,
    );

    if (!response.ok) {
      throw new Error(`Prometheus API error: ${response.statusText}`);
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Prometheus proxy error:', error);

    // Mock data fallback for local dev if Prometheus is unreachable
    if (process.env.NODE_ENV === 'development') {
      return NextResponse.json({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            {
              metric: { __name__: 'up' },
              value: [Date.now() / 1000, '1'],
            },
          ],
        },
      });
    }

    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
