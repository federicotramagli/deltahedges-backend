import { ProxyAgent } from "proxy-agent";
import { config } from "../config.js";
import { logger } from "../logger.js";
import {
  getProxyInventoryEntryById,
  recordProxyVerificationResult,
} from "./proxy-service.js";

export interface ProxyVerificationSnapshot {
  proxyId: string;
  endpointUrl: string;
  success: boolean;
  responseStatus: number | null;
  observedIp: string | null;
  observedCountryCode: string | null;
  observedRegion: string | null;
  errorMessage: string | null;
  responseBodyPreview: string | null;
}

function parseJsonSafely(payload: string) {
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractVerificationFields(
  payload: Record<string, unknown> | null,
  responseBody: string,
) {
  if (!payload) {
    return {
      observedIp: null,
      observedCountryCode: null,
      observedRegion: null,
      responseBodyPreview: responseBody.slice(0, 500) || null,
    };
  }

  return {
    observedIp: firstString(payload, [
      "ip",
      "origin",
      "clientIp",
      "client_ip",
      "remoteIp",
      "remote_ip",
      "address",
    ]),
    observedCountryCode: firstString(payload, [
      "countryCode",
      "country_code",
      "country",
    ]),
    observedRegion: firstString(payload, [
      "region",
      "regionCode",
      "region_code",
      "city",
    ]),
    responseBodyPreview: responseBody.slice(0, 500) || null,
  };
}

export async function verifyProxyInventoryEntry(params: {
  proxyId: string;
  endpointUrl: string;
  expectedCountryCode?: string | null;
  userId?: string | null;
}) {
  const proxy = await getProxyInventoryEntryById(params.proxyId);
  if (!proxy) {
    throw new Error("Proxy not found");
  }

  if (!proxy.proxyUrl) {
    throw new Error("Proxy entry is missing host, port or credentials");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.PROXY_VERIFICATION_TIMEOUT_MS);

  try {
    const response = await fetch(params.endpointUrl, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      },
      signal: controller.signal,
      dispatcher: new ProxyAgent({
        getProxyForUrl: () => proxy.proxyUrl ?? "",
      }),
    } as RequestInit & { dispatcher: ProxyAgent });

    const responseBody = await response.text();
    const parsedPayload = parseJsonSafely(responseBody);
    const extracted = extractVerificationFields(parsedPayload, responseBody);
    const expectedCountryCode = params.expectedCountryCode?.trim().toUpperCase() || null;
    const observedCountryCode = extracted.observedCountryCode?.trim().toUpperCase() || null;
    const countryMatches =
      !expectedCountryCode ||
      (observedCountryCode !== null && observedCountryCode === expectedCountryCode);
    const success = response.ok && countryMatches;

    const result: ProxyVerificationSnapshot = {
      proxyId: proxy.id,
      endpointUrl: params.endpointUrl,
      success,
      responseStatus: response.status,
      observedIp: extracted.observedIp,
      observedCountryCode,
      observedRegion: extracted.observedRegion,
      errorMessage: success
        ? null
        : countryMatches
          ? `Verification endpoint responded with status ${response.status}`
          : `Country mismatch: expected ${expectedCountryCode}, got ${observedCountryCode ?? "unknown"}`,
      responseBodyPreview: extracted.responseBodyPreview,
    };

    await recordProxyVerificationResult(
      {
        proxyId: proxy.id,
        endpointUrl: params.endpointUrl,
        userId: params.userId ?? null,
        success: result.success,
        responseStatus: result.responseStatus,
        observedIp: result.observedIp,
        observedCountryCode: result.observedCountryCode,
        observedRegion: result.observedRegion,
        errorMessage: result.errorMessage,
        metadata: {
          proxyEndpoint: proxy.host,
          proxyProvider: proxy.provider,
          responseBodyPreview: result.responseBodyPreview,
        },
      },
    );

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Proxy verification request failed";

    logger.warn(
      {
        error,
        proxyId: proxy.id,
        endpointUrl: params.endpointUrl,
      },
      "Residential proxy verification failed",
    );

    const result: ProxyVerificationSnapshot = {
      proxyId: proxy.id,
      endpointUrl: params.endpointUrl,
      success: false,
      responseStatus: null,
      observedIp: null,
      observedCountryCode: null,
      observedRegion: null,
      errorMessage: message,
      responseBodyPreview: null,
    };

    await recordProxyVerificationResult(
      {
        proxyId: proxy.id,
        endpointUrl: params.endpointUrl,
        userId: params.userId ?? null,
        success: false,
        responseStatus: null,
        observedIp: null,
        observedCountryCode: null,
        observedRegion: null,
        errorMessage: message,
        metadata: {
          proxyEndpoint: proxy.host,
          proxyProvider: proxy.provider,
        },
      },
    );

    return result;
  } finally {
    clearTimeout(timeout);
  }
}
