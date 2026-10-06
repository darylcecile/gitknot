import { Container, getContainer } from '@cloudflare/containers';
import { ApiError } from '../../packages/core/src/errors.ts';
import { verifyInternalRequest } from '../../packages/core/src/internal.ts';

interface EgressBindings {
  DB: D1Database;
  INTERNAL_SERVICE_KEY: string;
  ENVIRONMENT: string;
  EGRESS: DurableObjectNamespace<WebhookEgress>;
}

export class WebhookEgress extends Container<EgressBindings> {
  defaultPort = 8080;
  sleepAfter = '30s';
  enableInternet = true;

  envVars = { INTERNAL_SERVICE_KEY: this.env.INTERNAL_SERVICE_KEY, PORT: '8080', ENVIRONMENT: this.env.ENVIRONMENT };
}

export default {
  async fetch(request: Request, env: EgressBindings): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || !['/internal/webhooks/validate', '/internal/webhooks/send'].includes(url.pathname)) return new Response(null, { status: 404 });
      await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'webhook-egress', { database: env.DB });
      const bytes = crypto.getRandomValues(new Uint8Array(1));
      return await getContainer(env.EGRESS, `pool-${bytes[0]! % 2}`).fetch(request);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 503;
      return Response.json({ error: { code: status === 503 ? 'egress_unavailable' : 'invalid_service_credential', message: 'The private webhook transport could not complete the request.' } }, { status });
    }
  },
} satisfies ExportedHandler<EgressBindings>;
