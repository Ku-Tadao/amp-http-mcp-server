#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import fallbackSpec from "./amp-api-spec.json" with { type: "json" };

type AmpParameter = {
  Name: string;
  TypeName: string;
  Description?: string;
  Optional: boolean;
  ParamEnumValues?: string[] | null;
};

type AmpMethod = {
  Description?: string | null;
  Returns?: string | null;
  Parameters?: AmpParameter[];
  ReturnTypeName?: string;
  IsComplexType?: boolean;
  RequiredPermissions?: string[];
};

type AmpSpec = Record<string, Record<string, AmpMethod>>;
type AmpInstance = {
  InstanceID?: string;
  InstanceId?: string;
  InstanceName?: string;
  FriendlyName?: string;
  Group?: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
loadEnvFile(path.join(projectRoot, ".env"));

const server = new McpServer({
  name: "amp-http-mcp-server",
  version: "1.0.0",
});

let baseUrl = normalizeBaseUrl(process.env.AMP_BASE_URL ?? "https://amp.example.com");
let sessionId = process.env.AMP_SESSION_ID ?? "";
let cachedSpec: AmpSpec = fallbackSpec as AmpSpec;
let policyEnabled = process.env.AMP_POLICY_ENABLED !== "false";
let policyGroup = process.env.AMP_POLICY_GROUP ?? "AI";
let envLoginAttempted = false;

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(redact(value), null, 2),
      },
    ],
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] =
        /^(sessionID|sessionId|token|password|secret|authorization|rememberMeToken)$/i.test(key)
          ? "<redacted>"
          : redact(nested);
    }
    return output;
  }
  return value;
}

function methodMeta(moduleName: string, methodName: string) {
  const module = cachedSpec[moduleName];
  if (!module) {
    throw new Error(`Unknown AMP module "${moduleName}". Use amp_api_spec to list modules.`);
  }
  const method = module[methodName];
  if (!method) {
    throw new Error(`Unknown AMP method "${moduleName}/${methodName}". Use amp_api_spec to list methods.`);
  }
  return method;
}

function coerceValue(parameter: AmpParameter, value: unknown) {
  if (value === undefined || value === null) {
    if (parameter.Optional) return undefined;
    throw new Error(`Missing required parameter "${parameter.Name}" (${parameter.TypeName}).`);
  }
  if (value === "" && parameter.Optional) return undefined;

  switch (parameter.TypeName) {
    case "Boolean":
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      throw new Error(`Parameter "${parameter.Name}" must be a boolean.`);
    case "Int32":
      if (typeof value === "number" && Number.isInteger(value)) return value;
      if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
      throw new Error(`Parameter "${parameter.Name}" must be an integer.`);
    default:
      return value;
  }
}

function normalizeParams(meta: AmpMethod, params: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  for (const parameter of meta.Parameters ?? []) {
    const value = coerceValue(parameter, params[parameter.Name]);
    if (value !== undefined) body[parameter.Name] = value;
  }
  return body;
}

function requiresConfirmation(moduleName: string, methodName: string) {
  const name = `${moduleName}/${methodName}`.toLowerCase();
  return !(
    name === "core/getapispec" ||
    name === "core/getmoduleinfo" ||
    name === "core/getauthenticationrequirements" ||
    name === "core/getwebauthncredentialids" ||
    name === "core/getoidcloginurl" ||
    name === "core/login" ||
    name === "core/oidclogin"
  );
}

function shouldSkipEnvLogin(moduleName: string, methodName: string) {
  const name = `${moduleName}/${methodName}`.toLowerCase();
  return (
    Boolean(sessionId) ||
    name === "core/login" ||
    name === "core/getauthenticationrequirements" ||
    name === "core/getwebauthncredentialids" ||
    name === "core/getoidcloginurl" ||
    name === "core/oidclogin"
  );
}

async function ensureSession(moduleName: string, methodName: string) {
  if (shouldSkipEnvLogin(moduleName, methodName) || envLoginAttempted) return;

  const username = process.env.AMP_USERNAME;
  const password = process.env.AMP_PASSWORD;
  if (!username || !password) return;

  envLoginAttempted = true;
  await ampRequest("Core", "Login", {
    username,
    password,
    token: process.env.AMP_TOKEN ?? "",
    rememberMe: process.env.AMP_REMEMBER_ME === "true",
  });
}

async function ampRequest(moduleName: string, methodName: string, params: Record<string, unknown> = {}) {
  await ensureSession(moduleName, methodName);

  const url = `${baseUrl}/API/${encodeURIComponent(moduleName)}/${encodeURIComponent(methodName)}`;
  const body = { ...params, SESSIONID: sessionId };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${sessionId}`,
    },
    body: JSON.stringify(body),
  });

  const authHeader = response.headers.get("Authorization");
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (authHeader?.startsWith("Bearer ")) {
    sessionId = authHeader.slice("Bearer ".length);
  }
  if (data && typeof data === "object" && "sessionID" in data && typeof data.sessionID === "string") {
    sessionId = data.sessionID;
  }

  if (!response.ok) {
    throw new Error(`AMP HTTP ${response.status}: ${text}`);
  }

  return data;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function getKnownInstances() {
  const response = await ampRequest("ADSModule", "GetInstances", { ForceIncludeSelf: true });
  return asArray(response)
    .flatMap((group) => {
      if (group && typeof group === "object" && "AvailableInstances" in group) {
        return asArray((group as { AvailableInstances?: unknown }).AvailableInstances);
      }
      return [group];
    })
    .filter((instance): instance is AmpInstance => Boolean(instance && typeof instance === "object"));
}

async function getPolicyInstances() {
  const instances = await getKnownInstances();
  return instances.filter((instance) => (instance.Group ?? "") === policyGroup);
}

function getParam(params: Record<string, unknown>, ...names: string[]) {
  const found = Object.entries(params).find(([key]) => names.some((name) => key.toLowerCase() === name.toLowerCase()));
  return found?.[1];
}

async function assertPolicyAllows(moduleName: string, methodName: string, params: Record<string, unknown>) {
  if (!policyEnabled) return params;

  const callName = `${moduleName}/${methodName}`.toLowerCase();
  if (moduleName === "FileManagerPlugin") {
    const moduleInfo = await ampRequest("Core", "GetModuleInfo");
    const currentInstanceId =
      moduleInfo && typeof moduleInfo === "object" && "InstanceId" in moduleInfo
        ? String(moduleInfo.InstanceId)
        : "";
    const policyInstances = await getPolicyInstances();
    const allowed = policyInstances.some((instance) => {
      const id = instance.InstanceID ?? instance.InstanceId;
      return id && String(id).toLowerCase() === currentInstanceId.toLowerCase();
    });

    if (!allowed) {
      throw new Error(
        `Policy blocked ${moduleName}/${methodName}: file-manager calls are only allowed on instances in display group "${policyGroup}".`,
      );
    }

    return params;
  }

  if (moduleName !== "ADSModule") return params;

  if (["adsmodule/createinstance", "adsmodule/createinstancefromspec", "adsmodule/deploytemplate"].includes(callName)) {
    return { ...params, Group: policyGroup, DisplayGroup: policyGroup };
  }

  const targetId = getParam(params, "InstanceID", "InstanceId", "instanceId", "SourceInstanceId");
  const targetName = getParam(params, "InstanceName", "instanceName");
  if (!targetId && !targetName) return params;

  const policyInstances = await getPolicyInstances();
  const allowed = policyInstances.some((instance) => {
    const id = instance.InstanceID ?? instance.InstanceId;
    return (
      (targetId && String(id).toLowerCase() === String(targetId).toLowerCase()) ||
      (targetName && String(instance.InstanceName).toLowerCase() === String(targetName).toLowerCase())
    );
  });

  if (!allowed) {
    throw new Error(`Policy blocked ${moduleName}/${methodName}: target is not in display group "${policyGroup}".`);
  }

  if (methodName === "UpdateInstanceInfo") {
    return { ...params, DisplayGroup: policyGroup };
  }

  return params;
}

server.registerTool(
  "amp_configure",
  {
    description: "Set the AMP base URL and optional session ID for subsequent calls.",
    inputSchema: {
      baseUrl: z.string().url().optional(),
      sessionId: z.string().optional(),
      policyEnabled: z.boolean().optional(),
      policyGroup: z.string().optional(),
    },
  },
  async (args) => {
    if (args.baseUrl) baseUrl = normalizeBaseUrl(args.baseUrl);
    if (args.sessionId !== undefined) sessionId = args.sessionId;
    if (args.policyEnabled !== undefined) policyEnabled = args.policyEnabled;
    if (args.policyGroup) policyGroup = args.policyGroup;
    return textResult({ baseUrl, hasSession: sessionId.length > 0, policyEnabled, policyGroup });
  },
);

server.registerTool(
  "amp_api_spec",
  {
    description: "Return the AMP API spec. Optionally refresh from /API/Core/GetAPISpec.",
    inputSchema: {
      refresh: z.boolean().optional(),
      moduleName: z.string().optional(),
    },
  },
  async ({ refresh, moduleName }) => {
    if (refresh) {
      cachedSpec = (await ampRequest("Core", "GetAPISpec")) as AmpSpec;
    }
    return textResult(moduleName ? { [moduleName]: cachedSpec[moduleName] ?? null } : cachedSpec);
  },
);

server.registerTool(
  "amp_module_info",
  {
    description: "Call Core/GetModuleInfo.",
    inputSchema: {},
  },
  async () => textResult(await ampRequest("Core", "GetModuleInfo")),
);

server.registerTool(
  "amp_policy_instances",
  {
    description: "List the AMP instances currently allowed by the MCP policy group.",
    inputSchema: {},
  },
  async () => textResult({ policyEnabled, policyGroup, instances: await getPolicyInstances() }),
);

server.registerTool(
  "amp_auth_requirements",
  {
    description: "Call Core/GetAuthenticationRequirements for a username.",
    inputSchema: {
      username: z.string().min(1),
    },
  },
  async ({ username }) => textResult(await ampRequest("Core", "GetAuthenticationRequirements", { username })),
);

server.registerTool(
  "amp_login",
  {
    description: "Authenticate with Core/Login and store the returned session in memory. The session is redacted from output.",
    inputSchema: {
      username: z.string().min(1),
      password: z.string().min(1),
      token: z.string().optional().describe("Two-factor token/PIN if required."),
      rememberMe: z.boolean().optional(),
    },
  },
  async ({ username, password, token, rememberMe }) => {
    const result = await ampRequest("Core", "Login", {
      username,
      password,
      token: token ?? "",
      rememberMe: rememberMe ?? false,
    });
    return textResult({ baseUrl, hasSession: sessionId.length > 0, loginResult: result });
  },
);

server.registerTool(
  "amp_login_from_env",
  {
    description:
      "Authenticate using AMP_USERNAME, AMP_PASSWORD, optional AMP_TOKEN, and optional AMP_REMEMBER_ME from .env. Credentials are never returned.",
    inputSchema: {},
  },
  async () => {
    const username = process.env.AMP_USERNAME;
    const password = process.env.AMP_PASSWORD;
    if (!username || !password) {
      throw new Error("Set AMP_USERNAME and AMP_PASSWORD in .env before using amp_login_from_env.");
    }

    const result = await ampRequest("Core", "Login", {
      username,
      password,
      token: process.env.AMP_TOKEN ?? "",
      rememberMe: process.env.AMP_REMEMBER_ME === "true",
    });
    return textResult({ baseUrl, hasSession: sessionId.length > 0, loginResult: result });
  },
);

server.registerTool(
  "amp_clear_session",
  {
    description: "Forget the stored AMP session ID.",
    inputSchema: {},
  },
  async () => {
    sessionId = "";
    return textResult({ baseUrl, hasSession: false });
  },
);

server.registerTool(
  "amp_call",
  {
    description: "Call any method from the captured/refreshed AMP API spec.",
    inputSchema: {
      moduleName: z.string().min(1),
      methodName: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
      confirm: z.boolean().optional().describe("Required for state-changing methods."),
    },
  },
  async ({ moduleName, methodName, params, confirm }) => {
    const meta = methodMeta(moduleName, methodName);
    if (requiresConfirmation(moduleName, methodName) && !confirm) {
      throw new Error(`Refusing to call state-changing method ${moduleName}/${methodName} without confirm: true.`);
    }
    const body = normalizeParams(meta, params ?? {});
    const policyBody = await assertPolicyAllows(moduleName, methodName, body);
    return textResult(await ampRequest(moduleName, methodName, policyBody));
  },
);

async function selfTest() {
  const modules = Object.keys(cachedSpec);
  const methods = modules.reduce((sum, moduleName) => sum + Object.keys(cachedSpec[moduleName] ?? {}).length, 0);
  const result: Record<string, unknown> = {
    baseUrl,
    hasUsername: Boolean(process.env.AMP_USERNAME),
    hasPassword: Boolean(process.env.AMP_PASSWORD),
    hasSession: Boolean(sessionId),
    policyEnabled,
    policyGroup,
    modules,
    methods,
  };

  if (process.argv.includes("--self-test-login")) {
    if (!process.env.AMP_USERNAME || !process.env.AMP_PASSWORD) {
      throw new Error("Set AMP_USERNAME and AMP_PASSWORD in .env to run --self-test-login.");
    }
    const loginResult = await ampRequest("Core", "Login", {
      username: process.env.AMP_USERNAME,
      password: process.env.AMP_PASSWORD,
      token: process.env.AMP_TOKEN ?? "",
      rememberMe: process.env.AMP_REMEMBER_ME === "true",
    });
    result.loginResult = redact(loginResult);
    result.hasSession = Boolean(sessionId);
  }

  console.error(JSON.stringify(result, null, 2));
}

async function main() {
  if (process.argv.includes("--self-test") || process.argv.includes("--self-test-login")) {
    await selfTest();
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`amp-http-mcp-server connected for ${baseUrl}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
