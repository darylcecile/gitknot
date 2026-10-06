interface LocalRouterBindings { API: Fetcher; GIT: Fetcher; BACKGROUND: Fetcher; SECRETS: Fetcher }

// This module is only an entrypoint in .gitknot/projects/development. The
// loopback HTTP proxy supplies the selector for stock Git clients on :8788.
export default {
  fetch(request: Request, env: LocalRouterBindings): Promise<Response> {
    const headers = new Headers(request.headers);
    const service = headers.get('x-gitknot-local-service');
    headers.delete('x-gitknot-local-service');
    const forwarded = new Request(request, { headers });
    const target = service === 'git' ? env.GIT : service === 'background' ? env.BACKGROUND : service === 'secrets' ? env.SECRETS : env.API;
    return target.fetch(forwarded);
  },
} satisfies ExportedHandler<LocalRouterBindings>;
