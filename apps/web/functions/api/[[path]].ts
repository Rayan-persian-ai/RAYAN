/**
 * Cloudflare Pages Function: forwards /api/* to the rayan-api Worker through a
 * service binding (no public hop, free). Keeps the session cookie first-party
 * (same origin as the web app), so SameSite=Lax + __Host- cookies just work.
 * Binding is declared in apps/web/wrangler.toml ([[services]] API -> rayan-api).
 */
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export const onRequest = async (ctx: { request: Request; env: { API?: Fetcher } }): Promise<Response> => {
  if (!ctx.env.API) {
    return new Response(JSON.stringify({ error: { code: "internal", message: "اتصال به API پیکربندی نشده است." } }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return ctx.env.API.fetch(ctx.request);
};
