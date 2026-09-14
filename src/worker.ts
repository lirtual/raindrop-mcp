/** Cloudflare Workers entry point for the Raindrop MCP server. */
import { createMcpHandler } from "@modelcontextprotocol/server";
import pkg from "../package.json";
import { RaindropMCPService } from "./services/raindropmcp.service.js";
import { createLogger } from "./utils/logger.js";

interface Env {
  RAINDROP_ACCESS_TOKEN: string;
  RAINDROP_RATE_LIMIT_POINTS?: string;
  RAINDROP_RATE_LIMIT_DURATION_SECONDS?: string;
  RAINDROP_RATE_LIMIT_MAX_RETRIES?: string;
}

const logger = createLogger("worker");

const mcpHandler = createMcpHandler(
  () => new RaindropMCPService().getServer(),
  {
    legacy: "stateless",
    responseMode: "auto",
    onerror: (error) => logger.error("MCP handler error", error),
  },
);

const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, MCP-Protocol-Version, MCP-Param-*, MCP-Session-Id",
};

const withCors = (response: Response, origin: string | null) => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const isEmptyCompatibilityProbe = (request: Request) => {
  if (request.method !== "POST") return false;

  const contentLength = request.headers.get("Content-Length");
  const contentType = request.headers.get("Content-Type")?.toLowerCase();

  // ChatGPT performs a reachability/authentication probe with an empty body and
  // application/octet-stream before sending a real MCP JSON-RPC initialize call.
  // Keep this exception narrowly scoped so malformed real MCP requests still
  // receive the SDK's normal 415/400 responses.
  return contentLength === "0" && contentType === "application/octet-stream";
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          ...(origin
            ? {
                "Access-Control-Allow-Origin": origin,
                Vary: "Origin",
              }
            : {}),
        },
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return withCors(
        Response.json({
          status: "healthy",
          service: "raindrop-mcp",
          version: pkg.version,
          runtime: "cloudflare-workers",
          protocolTarget: "2026-07-28",
          httpMode: "per-request",
        }),
        origin,
      );
    }

    if (url.pathname !== "/mcp") {
      return withCors(
        Response.json(
          {
            error: "Not Found",
            endpoints: {
              mcp: "/mcp",
              health: "/health",
            },
          },
          { status: 404 },
        ),
        origin,
      );
    }

    if (!env.RAINDROP_ACCESS_TOKEN) {
      return withCors(
        Response.json(
          { error: "RAINDROP_ACCESS_TOKEN is not configured" },
          { status: 500 },
        ),
        origin,
      );
    }

    if (isEmptyCompatibilityProbe(request)) {
      logger.info("Accepted empty MCP compatibility probe");
      return withCors(new Response(null, { status: 204 }), origin);
    }

    // createMcpHandler returns a web-standard fetch-shaped handler object
    // ({ fetch, close, notify, bus }), not a directly callable function.
    const response = await mcpHandler.fetch(request);
    return withCors(response, origin);
  },
};
