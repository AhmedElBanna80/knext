export const dynamic = 'force-dynamic';

type Item = { id: number; name: string };

export default async function Page() {
  const port = process.env.PORT ?? '3000';
  const res = await fetch(`http://127.0.0.1:${port}/api/items`, { cache: 'no-store' });
  const items: Item[] = await res.json();
  return (
    <main>
      <h1>bench</h1>
      <p>items:{items.length}</p>
      <ul>
        {items.map((it) => (
          <li key={it.id}>{it.name}</li>
        ))}
      </ul>
    </main>
  );
}
