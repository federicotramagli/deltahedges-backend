import fs from "node:fs/promises";

type CliOptions = {
  apiBaseUrl: string;
  token: string;
  file: string;
  provider: string;
  country: string;
  protocol: "http" | "https" | "socks5";
  stickyTtlMinutes: number;
  assignEmail?: string;
  verifyEndpointUrl?: string;
  expectedCountryCode?: string;
  allowInsecureTls?: boolean;
};

type ParsedProxyLine = {
  ipAddress: string;
  host: string;
  port: number;
  username: string;
  password: string;
  countryCode: string;
  provider: string;
  protocol: "http" | "https" | "socks5";
  stickySessionTtlMinutes: number;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apiBaseUrl: "https://deltahedgeapi-production.up.railway.app",
    token: "",
    file: "",
    provider: "webshare",
    country: "IT",
    protocol: "http",
    stickyTtlMinutes: 60,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--api-base" && next) {
      options.apiBaseUrl = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--token" && next) {
      options.token = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--file" && next) {
      options.file = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--provider" && next) {
      options.provider = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--country" && next) {
      options.country = next.trim().toUpperCase();
      index += 1;
      continue;
    }

    if (arg === "--protocol" && next && ["http", "https", "socks5"].includes(next)) {
      options.protocol = next as CliOptions["protocol"];
      index += 1;
      continue;
    }

    if (arg === "--sticky-ttl" && next) {
      options.stickyTtlMinutes = Number(next);
      index += 1;
      continue;
    }

    if (arg === "--assign-email" && next) {
      options.assignEmail = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--verify-endpoint" && next) {
      options.verifyEndpointUrl = next.trim();
      index += 1;
      continue;
    }

    if (arg === "--expected-country" && next) {
      options.expectedCountryCode = next.trim().toUpperCase();
      index += 1;
      continue;
    }

    if (arg === "--allow-insecure-tls") {
      options.allowInsecureTls = true;
      continue;
    }
  }

  if (!options.token) {
    throw new Error("Missing required --token");
  }

  if (!options.file) {
    throw new Error("Missing required --file");
  }

  return options;
}

function parseProxyLine(line: string, options: CliOptions): ParsedProxyLine {
  const parts = line.trim().split(":");
  if (parts.length !== 4) {
    throw new Error(`Invalid proxy line format: ${line}`);
  }

  const [host, portRaw, username, password] = parts;
  const port = Number(portRaw);

  if (!host || !Number.isFinite(port) || !username || !password) {
    throw new Error(`Invalid proxy line content: ${line}`);
  }

  return {
    ipAddress: `${host}:${port}`,
    host,
    port,
    username,
    password,
    countryCode: options.country,
    provider: options.provider,
    protocol: options.protocol,
    stickySessionTtlMinutes: options.stickyTtlMinutes,
  };
}

async function readProxyFile(file: string, options: CliOptions) {
  const content = await fs.readFile(file, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseProxyLine(line, options));
}

async function apiFetch(
  apiBaseUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
) {
  const response = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!response.ok) {
    throw new Error(
      `API ${path} failed with ${response.status}: ${
        typeof json === "string" ? json : JSON.stringify(json)
      }`,
    );
  }

  return json;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const proxies = await readProxyFile(options.file, options);

  const imported = await apiFetch(options.apiBaseUrl, options.token, "/proxies/import", {
    method: "POST",
    body: JSON.stringify({ proxies }),
  });

  let assignment: unknown = null;

  if (options.assignEmail) {
    assignment = await apiFetch(options.apiBaseUrl, options.token, "/proxies/assign", {
      method: "POST",
      body: JSON.stringify({
        email: options.assignEmail,
        billingCountry: options.country,
        verifyEndpointUrl: options.verifyEndpointUrl,
        expectedCountryCode: options.expectedCountryCode,
        allowInsecureTls: options.allowInsecureTls ?? false,
      }),
    });
  }

  console.log(
    JSON.stringify(
      {
        importedCount: proxies.length,
        imported,
        assignment,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
