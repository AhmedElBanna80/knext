import { Counter } from './counter';

// Rendered on every request, with no database: the one route in this app that a
// test can drive through a successful (200) server render. The no-dev-modules
// runtime proof requests it as HTML and as an RSC payload, so React's server
// renderer and the client-component reference path both run in the traced process.
export const dynamic = 'force-dynamic';

export default async function RenderProbe() {
  const renderedAt = new Date().toISOString();
  return (
    <main style={{ maxWidth: 640, margin: '2rem auto', fontFamily: 'system-ui' }}>
      <h1>render probe</h1>
      <p>
        Rendered at <time dateTime={renderedAt}>{renderedAt}</time>.
      </p>
      <Counter />
    </main>
  );
}
