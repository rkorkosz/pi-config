import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

type LspServerConfig = {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  languageId?: string;
  languageIds?: string[];
  fileExtensions?: string[];
  rootPatterns?: string[];
  initializationOptions?: unknown;
  settings?: unknown;
};

type LspConfig = {
  servers: Record<string, Omit<LspServerConfig, "name">> | Array<LspServerConfig>;
};

type OpenDocumentState = {
  text: string;
  version: number;
  languageId: string;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
};

const clients = new Map<string, ManagedLspClient>();

function readJsonFile(path: string): any | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeServers(config: unknown): LspServerConfig[] {
  if (!config || typeof config !== "object") return [];
  const servers = (config as LspConfig).servers as any;
  if (!servers) return [];

  if (Array.isArray(servers)) {
    return servers
      .filter((server) => server && typeof server === "object" && typeof server.name === "string" && typeof server.command === "string")
      .map((server) => ({
        name: server.name,
        command: server.command,
        args: Array.isArray(server.args) ? server.args.map(String) : undefined,
        cwd: typeof server.cwd === "string" ? server.cwd : undefined,
        env: server.env && typeof server.env === "object" ? Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, String(v)])) : undefined,
        languageId: typeof server.languageId === "string" ? server.languageId : undefined,
        languageIds: Array.isArray(server.languageIds) ? server.languageIds.map(String) : undefined,
        fileExtensions: Array.isArray(server.fileExtensions) ? server.fileExtensions.map(String) : undefined,
        rootPatterns: Array.isArray(server.rootPatterns) ? server.rootPatterns.map(String) : undefined,
        initializationOptions: server.initializationOptions,
        settings: server.settings,
      }));
  }

  return Object.entries(servers)
    .filter(([, server]) => server && typeof server === "object" && typeof (server as any).command === "string")
    .map(([name, server]) => ({
      name,
      command: (server as any).command,
      args: Array.isArray((server as any).args) ? (server as any).args.map(String) : undefined,
      cwd: typeof (server as any).cwd === "string" ? (server as any).cwd : undefined,
      env: (server as any).env && typeof (server as any).env === "object" ? Object.fromEntries(Object.entries((server as any).env).map(([k, v]) => [k, String(v)])) : undefined,
      languageId: typeof (server as any).languageId === "string" ? (server as any).languageId : undefined,
      languageIds: Array.isArray((server as any).languageIds) ? (server as any).languageIds.map(String) : undefined,
      fileExtensions: Array.isArray((server as any).fileExtensions) ? (server as any).fileExtensions.map(String) : undefined,
      rootPatterns: Array.isArray((server as any).rootPatterns) ? (server as any).rootPatterns.map(String) : undefined,
      initializationOptions: (server as any).initializationOptions,
      settings: (server as any).settings,
    }));
}

function findConfigPath(cwd: string): string | undefined {
  const candidates = [join(cwd, "agent", "lsp.json"), join(cwd, ".pi", "lsp.json"), join(homedir(), ".pi", "agent", "lsp.json")].filter(Boolean);
  return candidates.find((path) => existsSync(path));
}

function loadConfig(cwd: string): { path?: string; servers: LspServerConfig[] } {
  const path = findConfigPath(cwd);
  if (!path) return { servers: [] };
  const parsed = readJsonFile(path);
  return { path, servers: normalizeServers(parsed) };
}

function toFileUri(filePath: string): string {
  return pathToFileURL(filePath).href;
}

function normalizePath(input: string, baseDir: string): string {
  return isAbsolute(input) ? input : resolve(baseDir, input);
}

function guessLanguageId(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".js":
      return "javascript";
    case ".jsx":
      return "javascriptreact";
    case ".mjs":
      return "javascript";
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".java":
      return "java";
    case ".rb":
      return "ruby";
    default:
      return "plaintext";
  }
}

function flattenHoverContents(contents: any): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map((item) => flattenHoverContents(item)).filter(Boolean).join("\n\n");
  if (typeof contents === "object") {
    if (typeof contents.value === "string") {
      return typeof contents.language === "string"
        ? `\`\`\`${contents.language}\n${contents.value}\n\`\`\``
        : contents.value;
    }
  }
  return JSON.stringify(contents, null, 2);
}

function formatPosition(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}

function formatLocation(location: any): string {
  if (!location) return "";
  const uri = location.uri ?? location.targetUri;
  const range = location.range ?? location.targetRange ?? location.targetSelectionRange;
  if (!uri || !range) return JSON.stringify(location);
  const start = range.start ?? range;
  const filePath = decodeURIComponent(String(uri).replace(/^file:\/\//, ""));
  return `${filePath}:${formatPosition(start.line ?? 0, start.character ?? 0)}`;
}

function flattenSymbols(symbols: any[], depth = 0): string[] {
  const out: string[] = [];
  for (const symbol of symbols ?? []) {
    if (!symbol) continue;
    const name = symbol.name ?? symbol.detail ?? "<unknown>";
    const kind = symbol.kind ? String(symbol.kind) : "symbol";
    const location = symbol.location ? formatLocation(symbol.location) : symbol.uri && symbol.range ? formatLocation({ uri: symbol.uri, range: symbol.range }) : "";
    out.push(`${"  ".repeat(depth)}${name} [${kind}]${location ? ` — ${location}` : ""}`);
    if (Array.isArray(symbol.children)) {
      out.push(...flattenSymbols(symbol.children, depth + 1));
    }
  }
  return out;
}

function resolveRootPatterns(cwd: string, filePath: string | undefined, patterns: string[] | undefined): string {
  if (!patterns?.length) return cwd;
  const start = filePath ? dirname(filePath) : cwd;
  let dir = start;
  while (true) {
    if (patterns.some((pattern) => existsSync(join(dir, pattern)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

function matchesExtensions(filePath: string, exts?: string[]): boolean {
  if (!exts?.length) return false;
  const ext = extname(filePath).toLowerCase();
  return exts.some((candidate) => candidate.toLowerCase() === ext);
}

function pickServer(servers: LspServerConfig[], explicit: string | undefined, filePath: string | undefined): LspServerConfig | undefined {
  if (explicit) return servers.find((server) => server.name === explicit);
  if (filePath) {
    const match = servers.find((server) => matchesExtensions(filePath, server.fileExtensions));
    if (match) return match;
  }
  return servers.length === 1 ? servers[0] : undefined;
}

function configFingerprint(server: LspServerConfig): string {
  return JSON.stringify({
    command: server.command,
    args: server.args ?? [],
    cwd: server.cwd ?? "",
    env: server.env ?? {},
    languageId: server.languageId ?? "",
    languageIds: server.languageIds ?? [],
    fileExtensions: server.fileExtensions ?? [],
    rootPatterns: server.rootPatterns ?? [],
    initializationOptions: server.initializationOptions ?? null,
    settings: server.settings ?? null,
  });
}

class ManagedLspClient {
  private proc?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = Buffer.alloc(0);
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private openDocuments = new Map<string, OpenDocumentState>();
  private diagnosticsByUri = new Map<string, any[]>();
  private startPromise?: Promise<void>;
  private stderrTail: string[] = [];

  constructor(private readonly server: LspServerConfig, private readonly cwd: string) {}

  async request(method: string, params: any = {}, signal?: AbortSignal): Promise<any> {
    await this.ensureStarted(signal);
    return await this.sendRequest(method, params, signal);
  }

  async syncDocument(filePath: string, signal?: AbortSignal): Promise<void> {
    await this.openDocument(filePath, signal);
  }

  async hover(filePath: string, line: number, character: number, signal?: AbortSignal) {
    await this.openDocument(filePath, signal);
    return await this.request("textDocument/hover", {
      textDocument: { uri: toFileUri(filePath) },
      position: { line, character },
    }, signal);
  }

  async definition(filePath: string, line: number, character: number, signal?: AbortSignal) {
    await this.openDocument(filePath, signal);
    return await this.request("textDocument/definition", {
      textDocument: { uri: toFileUri(filePath) },
      position: { line, character },
    }, signal);
  }

  async references(filePath: string, line: number, character: number, signal?: AbortSignal) {
    await this.openDocument(filePath, signal);
    return await this.request("textDocument/references", {
      textDocument: { uri: toFileUri(filePath) },
      position: { line, character },
      context: { includeDeclaration: true },
    }, signal);
  }

  async documentSymbols(filePath: string, signal?: AbortSignal) {
    await this.openDocument(filePath, signal);
    return await this.request("textDocument/documentSymbol", {
      textDocument: { uri: toFileUri(filePath) },
    }, signal);
  }

  async diagnostics(filePath: string, signal?: AbortSignal) {
    await this.openDocument(filePath, signal);
    return this.diagnosticsByUri.get(toFileUri(filePath)) ?? [];
  }

  async dispose(): Promise<void> {
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(new Error("LSP client disposed"));
    }
    this.pending.clear();

    if (this.proc && !this.proc.killed) {
      try {
        void this.sendRequestRaw("shutdown", {}, undefined).catch(() => undefined);
        this.notify("exit", {});
        this.proc.kill();
      } catch {}
    }
    this.proc = undefined;
    this.startPromise = undefined;
    this.openDocuments.clear();
    this.diagnosticsByUri.clear();
  }

  getServerInfo() {
    return {
      name: this.server.name,
      command: this.server.command,
      args: this.server.args ?? [],
      cwd: this.server.cwd ? normalizePath(this.server.cwd, this.cwd) : this.cwd,
      root: resolveRootPatterns(this.cwd, undefined, this.server.rootPatterns),
      fileExtensions: this.server.fileExtensions ?? [],
      languageIds: this.server.languageIds ?? (this.server.languageId ? [this.server.languageId] : []),
    };
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.start(signal);
    return await this.startPromise;
  }

  private async start(signal?: AbortSignal): Promise<void> {
    const cwd = this.server.cwd ? normalizePath(this.server.cwd, this.cwd) : this.cwd;
    const proc = spawn(this.server.command, this.server.args ?? [], {
      cwd,
      env: { ...process.env, ...(this.server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.on("error", (error: any) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });

    proc.on("exit", (code: any, sig: any) => {
      this.failAll(new Error(`LSP server ${this.server.name} exited (${sig ?? code ?? "unknown"})`));
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderrTail.push(...text.split(/\r?\n/).filter(Boolean));
      if (this.stderrTail.length > 20) this.stderrTail = this.stderrTail.slice(-20);
    });

    proc.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));

    const root = resolveRootPatterns(cwd, undefined, this.server.rootPatterns);
    try {
      await this.sendRequestRaw(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "pi-lsp-wrapper", version: "0.1.0" },
          rootUri: toFileUri(root),
          workspaceFolders: [{ uri: toFileUri(root), name: this.server.name }],
          capabilities: {
            textDocument: {
              hover: { dynamicRegistration: false },
              definition: { dynamicRegistration: false },
              references: { dynamicRegistration: false },
              documentSymbol: { dynamicRegistration: false },
            },
          },
          initializationOptions: this.server.initializationOptions ?? {},
        },
        signal,
      );
      this.notify("initialized", {});
    } catch (error) {
      try {
        proc.kill();
      } catch {}
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.stdoutBuffer.slice(0, headerEnd).toString("utf8");
      const match = /content-length:\s*(\d+)/i.exec(headerText);
      if (!match) {
        this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.stdoutBuffer.length < bodyStart + contentLength) return;
      const body = this.stdoutBuffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
      this.stdoutBuffer = this.stdoutBuffer.slice(bodyStart + contentLength);
      this.handleMessage(JSON.parse(body));
    }
  }

  private handleMessage(message: any): void {
    if (message && typeof message.id !== "undefined") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.cleanup?.();
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri;
      const diagnostics = Array.isArray(message.params?.diagnostics) ? message.params.diagnostics : [];
      if (typeof uri === "string") this.diagnosticsByUri.set(uri, diagnostics);
    }
  }

  private async openDocument(filePath: string, signal?: AbortSignal): Promise<void> {
    const uri = toFileUri(filePath);
    const text = readFileSync(filePath, "utf8");
    const languageId = this.server.languageId ?? this.server.languageIds?.[0] ?? guessLanguageId(filePath);
    const existing = this.openDocuments.get(uri);

    await this.ensureStarted(signal);

    if (!existing) {
      this.openDocuments.set(uri, { text, version: 1, languageId });
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text,
        },
      });
      return;
    }

    if (existing.text !== text) {
      const version = existing.version + 1;
      this.openDocuments.set(uri, { text, version, languageId });
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
  }

  private notify(method: string, params: any): void {
    if (!this.proc?.stdin || this.proc.killed) return;
    const json = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
  }

  private async sendRequest(method: string, params: any, signal?: AbortSignal): Promise<any> {
    return await this.sendRequestRaw(method, params, signal);
  }

  private async sendRequestRaw(method: string, params: any, signal?: AbortSignal): Promise<any> {
    if (!this.proc?.stdin || this.proc.killed) throw new Error(`LSP server ${this.server.name} is not running`);

    const id = this.nextRequestId++;
    const json = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return await new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (signal) {
        if (signal.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        const onAbort = () => {
          this.pending.delete(id);
          pending.cleanup?.();
          reject(new Error("Aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, pending);
      try {
        this.proc!.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
      } catch (error) {
        this.pending.delete(id);
        pending.cleanup?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
    this.proc = undefined;
    this.startPromise = undefined;
    this.openDocuments.clear();
    this.diagnosticsByUri.clear();
  }
}

function getOrCreateClient(cwd: string, server: LspServerConfig): ManagedLspClient {
  const key = `${cwd}::${server.name}::${configFingerprint(server)}`;
  const existing = clients.get(key);
  if (existing) return existing;

  for (const [clientKey, client] of clients.entries()) {
    if (clientKey.startsWith(`${cwd}::${server.name}::`)) {
      void client.dispose();
      clients.delete(clientKey);
    }
  }

  const client = new ManagedLspClient(server, cwd);
  clients.set(key, client);
  return client;
}

async function getServerContext(ctx: any, explicitServer?: string, filePath?: string) {
  const { path, servers } = loadConfig(ctx.cwd);
  const server = pickServer(servers, explicitServer, filePath);
  if (!server) {
    return {
      configPath: path,
      servers,
      server: undefined,
      error:
        servers.length === 0
          ? `No LSP config found. Create ${join(ctx.cwd, "agent", "lsp.json")} with a "servers" section.`
          : explicitServer
            ? `Unknown server "${explicitServer}". Available: ${servers.map((s) => s.name).join(", ")}`
            : filePath
              ? `No server matched ${filePath}. Add fileExtensions in agent/lsp.json or pass the server name explicitly.`
              : `Multiple LSP servers are configured. Pass a server name explicitly.`,
    };
  }

  return { configPath: path, servers, server, client: getOrCreateClient(ctx.cwd, server) };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    await Promise.all([...clients.values()].map((client) => client.dispose()));
    clients.clear();
  });

  pi.registerTool({
    name: "lsp_list_servers",
    label: "LSP Servers",
    description: "List servers from agent/lsp.json and show how they are matched",
    promptSnippet: "List configured LSP servers for the current codebase.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const { path, servers } = loadConfig(ctx.cwd);
      const lines = [path ? `Config: ${path}` : "Config: (missing)"];
      for (const server of servers) {
        const match = server.fileExtensions?.length ? `extensions=${server.fileExtensions.join(", ")}` : "extensions=(any)";
        const roots = server.rootPatterns?.length ? `roots=${server.rootPatterns.join(", ")}` : "roots=(cwd)";
        const langs = server.languageIds?.length ? `languages=${server.languageIds.join(", ")}` : server.languageId ? `language=${server.languageId}` : "languages=(infer)";
        lines.push(`- ${server.name}: ${server.command} ${server.args?.join(" ") ?? ""}`.trim());
        lines.push(`  ${match}; ${roots}; ${langs}`);
      }
      if (!servers.length) lines.push("No servers configured yet.");
      return { content: [{ type: "text", text: lines.join("\n") }], details: { configPath: path, servers } };
    },
  });

  pi.registerTool({
    name: "lsp_request",
    label: "LSP Request",
    description: "Send a raw LSP request to a configured server",
    promptSnippet: "Call an arbitrary LSP method on a configured server.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name from agent/lsp.json" },
        filePath: { type: "string", description: "Optional file path used to infer the server and open the document" },
        method: { type: "string", description: "LSP method name, e.g. textDocument/hover" },
        params: { description: "Raw JSON params", type: ["object", "array", "null"] },
        line: { type: "integer", description: "1-based line number", minimum: 1 },
        character: { type: "integer", description: "1-based character number", minimum: 1 },
      },
      required: ["method"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const filePath = params.filePath ? normalizePath(params.filePath, ctx.cwd) : undefined;
      const { error, server, client, configPath } = await getServerContext(ctx, params.server, filePath);
      if (error || !server || !client) {
        return { content: [{ type: "text", text: error ?? "No server selected" }], details: { configPath } };
      }

      const extra = params.params ?? {};
      let requestParams = extra;
      if (filePath && params.method.startsWith("textDocument/") && !("textDocument" in (extra ?? {}))) {
        const line = Math.max(0, Number(params.line ?? 1) - 1);
        const character = Math.max(0, Number(params.character ?? 1) - 1);
        requestParams = {
          textDocument: { uri: toFileUri(filePath) },
          position: { line, character },
          ...extra,
        };
      }

      if (filePath) {
        await client.syncDocument(filePath, signal);
      }

      const result = await client.request(params.method, requestParams, signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { server: server.name, configPath, result } };
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get hover information at a file position",
    promptSnippet: "Inspect hover docs or inferred types at a file position.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name from agent/lsp.json" },
        filePath: { type: "string", description: "File path to inspect" },
        line: { type: "integer", description: "1-based line number", minimum: 1 },
        character: { type: "integer", description: "1-based character number", minimum: 1 },
      },
      required: ["filePath", "line", "character"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const filePath = normalizePath(params.filePath, ctx.cwd);
      const { error, server, client } = await getServerContext(ctx, params.server, filePath);
      if (error || !server || !client) return { content: [{ type: "text", text: error ?? "No server selected" }], details: {} };

      const line = Math.max(0, Number(params.line) - 1);
      const character = Math.max(0, Number(params.character) - 1);
      const result = await client.hover(filePath, line, character, signal);
      return {
        content: [{ type: "text", text: flattenHoverContents(result?.contents ?? result) || "(no hover)" }],
        details: { server: server.name, result },
      };
    },
  });

  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Jump to definition locations for a symbol",
    promptSnippet: "Find where a symbol is defined.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name from agent/lsp.json" },
        filePath: { type: "string", description: "File path to inspect" },
        line: { type: "integer", description: "1-based line number", minimum: 1 },
        character: { type: "integer", description: "1-based character number", minimum: 1 },
      },
      required: ["filePath", "line", "character"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const filePath = normalizePath(params.filePath, ctx.cwd);
      const { error, server, client } = await getServerContext(ctx, params.server, filePath);
      if (error || !server || !client) return { content: [{ type: "text", text: error ?? "No server selected" }], details: {} };

      const line = Math.max(0, Number(params.line) - 1);
      const character = Math.max(0, Number(params.character) - 1);
      const result = await client.definition(filePath, line, character, signal);
      const locations = Array.isArray(result) ? result : result ? [result] : [];
      const text = locations.length ? locations.map((location) => formatLocation(location)).filter(Boolean).join("\n") : "(no definition)";
      return { content: [{ type: "text", text }], details: { server: server.name, result } };
    },
  });

  pi.registerTool({
    name: "lsp_references",
    label: "LSP References",
    description: "Find references for a symbol",
    promptSnippet: "Find references for a symbol across the codebase.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name from agent/lsp.json" },
        filePath: { type: "string", description: "File path to inspect" },
        line: { type: "integer", description: "1-based line number", minimum: 1 },
        character: { type: "integer", description: "1-based character number", minimum: 1 },
      },
      required: ["filePath", "line", "character"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const filePath = normalizePath(params.filePath, ctx.cwd);
      const { error, server, client } = await getServerContext(ctx, params.server, filePath);
      if (error || !server || !client) return { content: [{ type: "text", text: error ?? "No server selected" }], details: {} };

      const line = Math.max(0, Number(params.line) - 1);
      const character = Math.max(0, Number(params.character) - 1);
      const result = await client.references(filePath, line, character, signal);
      const locations = Array.isArray(result) ? result : result ? [result] : [];
      const text = locations.length ? locations.map((location) => formatLocation(location)).filter(Boolean).join("\n") : "(no references)";
      return { content: [{ type: "text", text }], details: { server: server.name, result } };
    },
  });

  pi.registerTool({
    name: "lsp_symbols",
    label: "LSP Symbols",
    description: "List document symbols for a file",
    promptSnippet: "Get an outline of symbols in a file.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name from agent/lsp.json" },
        filePath: { type: "string", description: "File path to inspect" },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const filePath = normalizePath(params.filePath, ctx.cwd);
      const { error, server, client } = await getServerContext(ctx, params.server, filePath);
      if (error || !server || !client) return { content: [{ type: "text", text: error ?? "No server selected" }], details: {} };

      const result = await client.documentSymbols(filePath, signal);
      const symbols = Array.isArray(result) ? result : [];
      const lines = symbols.length ? flattenSymbols(symbols) : ["(no symbols)"];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { server: server.name, result } };
    },
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Return the latest diagnostics reported for a file",
    promptSnippet: "Inspect the latest diagnostics for a file.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name from agent/lsp.json" },
        filePath: { type: "string", description: "File path to inspect" },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
    async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
      const filePath = normalizePath(params.filePath, ctx.cwd);
      const { error, server, client } = await getServerContext(ctx, params.server, filePath);
      if (error || !server || !client) return { content: [{ type: "text", text: error ?? "No server selected" }], details: {} };

      const diags = await client.diagnostics(filePath, signal);
      const severityLabel = (severity: any) => ({ 1: "error", 2: "warning", 3: "info", 4: "hint" } as Record<number, string>)[Number(severity)] ?? String(severity ?? "");
      const text = diags.length
        ? diags
            .map((diag) => {
              const start = diag.range?.start ?? { line: 0, character: 0 };
              return `${formatPosition(start.line ?? 0, start.character ?? 0)} ${severityLabel(diag.severity)} ${diag.message ?? ""}`.trim();
            })
            .join("\n")
        : "(no diagnostics cached yet)";
      return { content: [{ type: "text", text }], details: { server: server.name, diagnostics: diags } };
    },
  });
}
