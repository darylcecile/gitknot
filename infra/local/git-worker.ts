import { DurableObject } from 'cloudflare:workers';
export { default, RepositoryCoordinator } from '../../workers/git/src/index.ts';

// Only the ignored development wrapper selects this export. It preserves the
// real namespace/call path while replacing the VM with the local native process.
export class GitContainer extends DurableObject {
  fetch(request: Request): Promise<Response> {
    const source = new URL(request.url);
    return fetch(new Request(new URL(source.pathname + source.search, 'http://127.0.0.1:8790'), request), { redirect: 'manual' });
  }
}
