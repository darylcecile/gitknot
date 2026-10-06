// Explicit local transport to the same real DNS-pinning Node server used in
// the production Container. The server verifies the original signed envelope.
export default {
  fetch(request: Request): Promise<Response> {
    const source = new URL(request.url);
    const target = new URL(source.pathname + source.search, 'http://127.0.0.1:8791');
    return fetch(new Request(target, request), { redirect: 'manual' });
  },
} satisfies ExportedHandler;
