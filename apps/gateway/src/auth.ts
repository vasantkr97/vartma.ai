import { timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

export function createApiKeyAuth(apiKeys: string[]): RequestHandler {
  const encodedKeys = apiKeys.map((key) => Buffer.from(key));

  return (request, response, next) => {
    const supplied = extractApiKey(request.headers.authorization, request.header("x-api-key"));
    if (!supplied || !matchesAny(Buffer.from(supplied), encodedKeys)) {
      if (request.path === "/responses" || request.path === "/chat/completions") {
        response.status(401).json({
          error: {
            message: "A valid router API key is required.",
            type: "authentication_error",
            param: null,
            code: "invalid_api_key",
          },
        });
        return;
      }
      response.status(401).json({
        type: "error",
        error: {
          type: "authentication_error",
          message: "A valid router API key is required.",
        },
      });
      return;
    }
    next();
  };
}

function extractApiKey(
  authorization: string | undefined,
  headerApiKey: string | undefined,
): string | undefined {
  if (headerApiKey) {
    return headerApiKey;
  }
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return undefined;
}

function matchesAny(supplied: Buffer, expectedKeys: Buffer[]): boolean {
  let matched = false;
  for (const expected of expectedKeys) {
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      matched = true;
    }
  }
  return matched;
}
