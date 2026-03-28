import fs from "node:fs/promises";
import process from "node:process";

type CliOptions = {
  file?: string;
  provider: string;
  country: string;
  protocol: "http" | "https" | "socks5";
  stickyTtlMinutes: number;
  apply: boolean;
  stdin: boolean;
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
    file: undefined,
    provider: "webshare",
    country: "IT",
    protocol: "http",
    stickyTtlMinutes: 60,
    apply: false,
    stdin: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--file" && next) {
      options.file = next;
      index += 1;
      continue;
    }

    if (arg === "--provider" && next) {
      options.provider = next;
      index += 1;
      continue;
    }

    if (arg === "--country" && next) {
      options.country = next;
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

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--stdin") {
      options.stdin = true;
      continue;
    }
  }

  if (!options.file && !options.stdin) {
    throw new Error("Missing required --file argument or --stdin");
  }

  if (!Number.isFinite(options.stickyTtlMinutes) || options.stickyTtlMinutes <= 0) {
    throw new Error("Invalid --sticky-ttl value");
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
    countryCode: options.country.trim().toUpperCase(),
    provider: options.provider.trim(),
    protocol: options.protocol,
    stickySessionTtlMinutes: options.stickyTtlMinutes,
  };
}

async function readProxyContent(options: CliOptions) {
  const content = options.stdin
    ? await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        process.stdin.on("error", reject);
      })
    : await fs.readFile(options.file!, "utf8");

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseProxyLine(line, options));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const proxies = await readProxyContent(options);

  if (!options.apply) {
    console.log(
      JSON.stringify(
        {
          importedCount: proxies.length,
          provider: options.provider,
          country: options.country.toUpperCase(),
          protocol: options.protocol,
          stickySessionTtlMinutes: options.stickyTtlMinutes,
          sample: proxies.slice(0, 3).map((proxy) => ({
            ipAddress: proxy.ipAddress,
            host: proxy.host,
            port: proxy.port,
            countryCode: proxy.countryCode,
            provider: proxy.provider,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const { upsertProxyInventoryEntry } = await import("../services/proxy-service.js");

  for (const proxy of proxies) {
    await upsertProxyInventoryEntry({
      ipAddress: proxy.ipAddress,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      countryCode: proxy.countryCode,
      provider: proxy.provider,
      protocol: proxy.protocol,
      stickySessionTtlMinutes: proxy.stickySessionTtlMinutes,
      status: "AVAILABLE",
      providerReference: "webshare-import",
    });
  }

  console.log(
    JSON.stringify(
      {
        importedCount: proxies.length,
        provider: options.provider,
        country: options.country.toUpperCase(),
        applied: true,
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
