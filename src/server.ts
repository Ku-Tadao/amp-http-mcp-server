#!/usr/bin/env node
import { randomUUID } from "node:crypto";
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
  Module?: string;
  Port?: number;
  Running?: boolean;
  [key: string]: unknown;
};
type AmpRecord = Record<string, unknown>;

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
let managedInstance: AmpInstance | null = null;
let managedSessionId = "";

const defaultWaitTimeoutMs = Number(process.env.AMP_WAIT_TIMEOUT_MS ?? 120000);
const defaultPollMs = Number(process.env.AMP_POLL_MS ?? 3000);
const defaultManagedLoginTimeoutMs = Number(process.env.AMP_MANAGED_LOGIN_TIMEOUT_MS ?? 90000);
const defaultFileChunkBytes = Number(process.env.AMP_FILE_CHUNK_BYTES ?? 524288);
const defaultMaxReadBytes = Number(process.env.AMP_MAX_READ_BYTES ?? 1048576);

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

function findMethodMeta(moduleName: string, methodName: string) {
  return cachedSpec[moduleName]?.[methodName] ?? null;
}

async function resolveMethodMeta(moduleName: string, methodName: string) {
  let meta = findMethodMeta(moduleName, methodName);
  if (meta) return { meta, refreshed: false, refreshError: "" };

  try {
    cachedSpec = (await ampRequest("Core", "GetAPISpec")) as AmpSpec;
    meta = findMethodMeta(moduleName, methodName);
    return { meta, refreshed: true, refreshError: "" };
  } catch (error) {
    return {
      meta: null,
      refreshed: false,
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
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
  const method = methodName.toLowerCase();
  const readOnlyCalls = new Set([
    "adsmodule/getinstances",
    "adsmodule/getinstance",
    "adsmodule/getinstancestatuses",
    "adsmodule/getlocalinstances",
    "adsmodule/getsupportedapplications",
    "adsmodule/getsupportedappsummaries",
    "adsmodule/gettargetinfo",
    "core/getapispec",
    "core/getmoduleinfo",
    "core/getauthenticationrequirements",
    "core/getwebauthncredentialids",
    "core/getoidcloginurl",
    "core/login",
    "core/oidclogin",
    "core/getstatus",
    "core/getupdates",
    "filemanagerplugin/getdirectorylisting",
    "filemanagerplugin/readfilechunk",
  ]);
  if (readOnlyCalls.has(name)) return false;
  return !(
    method.startsWith("get") ||
    method.startsWith("list") ||
    method.startsWith("read")
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

function instanceIdOf(instance: AmpInstance | null) {
  return instance?.InstanceID ?? instance?.InstanceId ?? "";
}

async function ensureManagedSession(instance: AmpInstance, timeoutMs = defaultManagedLoginTimeoutMs) {
  if (managedSessionId) return;

  const username = process.env.AMP_USERNAME;
  const password = process.env.AMP_PASSWORD;
  if (!username || !password) {
    throw new Error("Managed instance API calls require AMP_USERNAME and AMP_PASSWORD.");
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() <= deadline) {
    const result = await ampRequest("Core", "Login", {
      username,
      password,
      token: process.env.AMP_TOKEN ?? "",
      rememberMe: false,
    }, instance);

    if (!isAmpError(result) && !isActionFailure(result) && managedSessionId) return;

    lastError = getAmpErrorMessage(result) || actionMessage(result) || JSON.stringify(redact(result));
    await sleep(defaultPollMs);
  }

  const name = instance.FriendlyName ?? instance.InstanceName ?? instanceIdOf(instance);
  throw new Error(`Could not log in to managed AMP instance "${name}" within ${timeoutMs}ms. Last response: ${lastError}`);
}

async function ampRequest(
  moduleName: string,
  methodName: string,
  params: Record<string, unknown> = {},
  instance: AmpInstance | null = null,
) {
  if (instance) {
    const id = instanceIdOf(instance);
    if (!id) throw new Error("Cannot make managed instance request without an instance ID.");
    if (methodName !== "Login") await ensureManagedSession(instance);

    const url = `${baseUrl}/API/ADSModule/Servers/${encodeURIComponent(id)}/API/${encodeURIComponent(moduleName)}/${encodeURIComponent(methodName)}`;
    const body = { ...params, SESSIONID: managedSessionId };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${managedSessionId || sessionId}`,
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
      managedSessionId = authHeader.slice("Bearer ".length);
    }
    if (data && typeof data === "object" && "sessionID" in data && typeof data.sessionID === "string") {
      managedSessionId = data.sessionID;
    }

    if (!response.ok) {
      throw new Error(`AMP HTTP ${response.status}: ${text}`);
    }

    return data;
  }

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

function isAmpError(value: unknown) {
  return Boolean(
    value &&
      typeof value === "object" &&
      ("Title" in value || "title" in value) &&
      ("Message" in value || "message" in value)
  );
}

function getAmpErrorMessage(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return String(record.Message ?? record.message ?? "");
}

function asRecord(value: unknown): AmpRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as AmpRecord) : null;
}

function isActionFailure(value: unknown) {
  const record = asRecord(value);
  return record?.Status === false || record?.status === false;
}

function actionMessage(value: unknown) {
  const record = asRecord(value);
  if (!record) return "";
  return String(
    record.Reason ??
      record.reason ??
      record.Message ??
      record.message ??
      record.Title ??
      record.title ??
      "",
  );
}

function actionResultValue(value: unknown) {
  const record = asRecord(value);
  return record && "Result" in record ? record.Result : value;
}

function assertAmpAccepted(context: string, value: unknown) {
  if (isAmpError(value) || isActionFailure(value)) {
    const message = getAmpErrorMessage(value) || actionMessage(value) || "AMP returned an error.";
    throw new Error(`AMP rejected ${context}: ${message}`);
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (!managedInstance) {
      throw new Error(
        `Policy blocked ${moduleName}/${methodName}: call ADSModule/ManageInstance for an instance in display group "${policyGroup}" first.`,
      );
    }

    const moduleInfo = await ampRequest("Core", "GetModuleInfo", {}, managedInstance);
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
      if (managedInstance) {
        throw new Error(
          `Policy blocked ${moduleName}/${methodName}: AMP returned a management handoff for "${managedInstance.InstanceName}", but the controller API did not switch into a usable instance session. Direct/proxied instance API access is required before file-manager calls can be made safely.`,
        );
      }
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

async function updateManagedInstance(moduleName: string, methodName: string, params: Record<string, unknown>, result: unknown) {
  if (moduleName !== "ADSModule" || methodName !== "ManageInstance" || isAmpError(result)) return;
  if (!result || typeof result !== "object" || !("Status" in result) || (result as { Status?: unknown }).Status !== true) {
    managedInstance = null;
    managedSessionId = "";
    return;
  }

  const targetId = getParam(params, "InstanceID", "InstanceId", "instanceId");
  const targetName = getParam(params, "InstanceName", "instanceName");
  const policyInstances = await getPolicyInstances();
  managedInstance =
    policyInstances.find((instance) => {
      const id = instance.InstanceID ?? instance.InstanceId;
      return (
        (targetId && String(id).toLowerCase() === String(targetId).toLowerCase()) ||
        (targetName && String(instance.InstanceName).toLowerCase() === String(targetName).toLowerCase())
      );
    }) ?? null;
  managedSessionId = "";
}

function instanceLabel(instance: AmpInstance | null) {
  if (!instance) return null;
  return instance.FriendlyName ?? instance.InstanceName ?? instanceIdOf(instance);
}

function instanceNameOrThrow(instance: AmpInstance) {
  if (!instance.InstanceName) {
    throw new Error(`Instance "${instanceLabel(instance)}" does not expose an InstanceName.`);
  }
  return instance.InstanceName;
}

function matchFields(instance: AmpInstance) {
  return [instanceIdOf(instance), instance.InstanceName, instance.FriendlyName]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function sameInstance(left: AmpInstance, right: AmpInstance) {
  const leftId = instanceIdOf(left).toLowerCase();
  const rightId = instanceIdOf(right).toLowerCase();
  if (leftId && rightId) return leftId === rightId;
  return String(left.InstanceName ?? "").toLowerCase() === String(right.InstanceName ?? "").toLowerCase();
}

function pickString(record: AmpRecord | null | undefined, ...keys: string[]) {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function pickNumber(record: AmpRecord | null | undefined, ...keys: string[]) {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function runningFromRecord(record: AmpRecord | null | undefined) {
  if (!record) return undefined;
  for (const key of ["Running", "IsRunning", "Started", "IsStarted"]) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }

  const state = pickString(record, "State", "Status", "AppState", "ApplicationState", "DaemonState")?.toLowerCase();
  if (!state) return undefined;
  if (/(stopped|offline|not running|notrunning|failed|unavailable)/.test(state)) return false;
  if (/(running|ready|idle|starting|updating|online|available)/.test(state)) return true;
  return undefined;
}

function isInstanceRunning(instance: AmpInstance, status?: AmpRecord | null) {
  return runningFromRecord(status) ?? runningFromRecord(instance);
}

async function getInstanceStatuses() {
  const response = await ampRequest("ADSModule", "GetInstanceStatuses");
  return asArray(response).flatMap((status) => {
    const record = asRecord(status);
    return record ? [record] : [];
  });
}

async function tryGetInstanceStatuses() {
  try {
    return { statuses: await getInstanceStatuses(), error: "" };
  } catch (error) {
    return { statuses: [] as AmpRecord[], error: error instanceof Error ? error.message : String(error) };
  }
}

function statusMatchesInstance(status: AmpRecord, instance: AmpInstance) {
  const statusId = pickString(status, "InstanceID", "InstanceId", "Id", "ID", "instanceId")?.toLowerCase();
  const instanceId = instanceIdOf(instance).toLowerCase();
  if (statusId && instanceId && statusId === instanceId) return true;

  const statusName = pickString(status, "InstanceName", "Name", "Instance", "instanceName")?.toLowerCase();
  const instanceName = String(instance.InstanceName ?? "").toLowerCase();
  return Boolean(statusName && instanceName && statusName === instanceName);
}

function findStatusForInstance(statuses: AmpRecord[], instance: AmpInstance) {
  return statuses.find((status) => statusMatchesInstance(status, instance)) ?? null;
}

function summarizeInstance(instance: AmpInstance, status?: AmpRecord | null, includeRaw = false) {
  const instanceRecord = asRecord(instance) ?? {};
  const summary: AmpRecord = {
    id: instanceIdOf(instance),
    instanceName: instance.InstanceName ?? null,
    friendlyName: instance.FriendlyName ?? null,
    module: pickString(instanceRecord, "Module", "ModuleName", "AppModule") ?? null,
    group: instance.Group ?? null,
    port: pickNumber(status, "Port", "PortNumber", "ApplicationPort") ?? pickNumber(instanceRecord, "Port", "PortNumber") ?? null,
    running: isInstanceRunning(instance, status) ?? null,
    state: pickString(status, "State", "Status", "AppState", "ApplicationState") ?? null,
  };

  if (includeRaw) {
    summary.instance = instance;
    summary.status = status ?? null;
  }

  return summary;
}

async function summarizePolicyInstances(includeRaw = false) {
  const instances = await getPolicyInstances();
  const { statuses, error } = await tryGetInstanceStatuses();
  return {
    policyEnabled,
    policyGroup,
    selected: instanceLabel(managedInstance),
    statusError: error || undefined,
    instances: instances.map((instance) => summarizeInstance(instance, findStatusForInstance(statuses, instance), includeRaw)),
  };
}

async function resolvePolicyInstance(query?: string, allowCurrent = true) {
  const instances = await getPolicyInstances();
  if (instances.length === 0) {
    throw new Error(`No instances are visible in display group "${policyGroup}".`);
  }

  const needle = query?.trim().toLowerCase();
  if (!needle) {
    if (allowCurrent && managedInstance) {
      const current = instances.find((instance) => sameInstance(instance, managedInstance as AmpInstance));
      if (current) return current;
    }
    if (instances.length === 1) return instances[0];
    throw new Error(
      `Pick an instance by name, friendly name, or ID. Allowed instances: ${instances.map((instance) => instanceLabel(instance)).join(", ")}`,
    );
  }

  const exact = instances.filter((instance) => matchFields(instance).some((field) => field.toLowerCase() === needle));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`More than one instance exactly matched "${query}": ${exact.map((instance) => instanceLabel(instance)).join(", ")}`);
  }

  const partial = instances.filter((instance) => matchFields(instance).some((field) => field.toLowerCase().includes(needle)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`More than one instance matched "${query}": ${partial.map((instance) => instanceLabel(instance)).join(", ")}`);
  }

  throw new Error(
    `No instance in display group "${policyGroup}" matched "${query}". Allowed instances: ${instances.map((instance) => instanceLabel(instance)).join(", ")}`,
  );
}

async function callAdsMethod(methodName: string, params: Record<string, unknown>) {
  const policyBody = await assertPolicyAllows("ADSModule", methodName, params);
  const result = await ampRequest("ADSModule", methodName, policyBody);
  await updateManagedInstance("ADSModule", methodName, policyBody, result);
  assertAmpAccepted(`ADSModule/${methodName}`, result);
  return result;
}

async function callManagedMethod(
  instance: AmpInstance,
  moduleName: string,
  methodName: string,
  params: Record<string, unknown> = {},
) {
  const policyBody = await assertPolicyAllows(moduleName, methodName, params);
  const result = await ampRequest(moduleName, methodName, policyBody, instance);
  assertAmpAccepted(`${moduleName}/${methodName}`, result);
  return result;
}

async function waitForInstanceState(instance: AmpInstance, desiredRunning: boolean, timeoutMs = defaultWaitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = summarizeInstance(instance);

  while (Date.now() <= deadline) {
    const statuses = await getInstanceStatuses();
    const status = findStatusForInstance(statuses, instance);
    latest = summarizeInstance(instance, status);
    if (latest.running === desiredRunning) return latest;
    await sleep(defaultPollMs);
  }

  throw new Error(
    `Timed out waiting for "${instanceLabel(instance)}" to become ${desiredRunning ? "running" : "stopped"}. Last status: ${JSON.stringify(latest)}`,
  );
}

async function statusForInstance(instance: AmpInstance) {
  const { statuses } = await tryGetInstanceStatuses();
  return summarizeInstance(instance, findStatusForInstance(statuses, instance));
}

async function startPolicyInstance(instance: AmpInstance, wait = true, timeoutMs = defaultWaitTimeoutMs) {
  const before = await statusForInstance(instance);
  if (before.running === true) return { alreadyRunning: true, status: before };

  const result = await callAdsMethod("StartInstance", { InstanceName: instanceNameOrThrow(instance) });
  if (!wait) return { alreadyRunning: false, result, status: await statusForInstance(instance) };
  return { alreadyRunning: false, result, status: await waitForInstanceState(instance, true, timeoutMs) };
}

async function stopPolicyInstance(instance: AmpInstance, wait = true, timeoutMs = defaultWaitTimeoutMs) {
  const before = await statusForInstance(instance);
  if (before.running === false) return { alreadyStopped: true, status: before };

  const result = await callAdsMethod("StopInstance", { InstanceName: instanceNameOrThrow(instance) });
  if (!wait) return { alreadyStopped: false, result, status: await statusForInstance(instance) };
  return { alreadyStopped: false, result, status: await waitForInstanceState(instance, false, timeoutMs) };
}

function shouldRetryManageAfterStart(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /(unavailable|not running|notrunning|stopped|offline|could not be contacted|connect)/i.test(message);
}

async function ensureManagedInstance(
  instance: AmpInstance,
  options: { startIfStopped?: boolean; waitTimeoutMs?: number } = {},
) {
  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
  let started = false;

  const status = await statusForInstance(instance);
  if (status.running === false && options.startIfStopped) {
    await startPolicyInstance(instance, true, waitTimeoutMs);
    started = true;
  }

  try {
    const result = await callAdsMethod("ManageInstance", { InstanceId: instanceIdOf(instance) });
    managedInstance ??= instance;
    await ensureManagedSession(managedInstance, waitTimeoutMs);
    return { instance: managedInstance, started, manageResult: result, status: await statusForInstance(managedInstance) };
  } catch (error) {
    if (!options.startIfStopped || !shouldRetryManageAfterStart(error)) throw error;
    await startPolicyInstance(instance, true, waitTimeoutMs);
    started = true;
    const result = await callAdsMethod("ManageInstance", { InstanceId: instanceIdOf(instance) });
    managedInstance ??= instance;
    await ensureManagedSession(managedInstance, waitTimeoutMs);
    return { instance: managedInstance, started, manageResult: result, status: await statusForInstance(managedInstance) };
  }
}

async function managedInstanceFor(query?: string, startIfStopped = true, waitTimeoutMs = defaultWaitTimeoutMs) {
  const instance = await resolvePolicyInstance(query, true);
  const ready = await ensureManagedInstance(instance, { startIfStopped, waitTimeoutMs });
  return ready.instance;
}

function normalizeAmpPath(value: string | undefined, fallback = ".") {
  const normalized = (value?.trim() || fallback).replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized || fallback;
}

function splitAmpPath(filePath: string) {
  const filename = normalizeAmpPath(filePath);
  const separator = filename.lastIndexOf("/");
  if (separator === -1) return { dir: ".", name: filename };
  return { dir: filename.slice(0, separator) || ".", name: filename.slice(separator + 1) };
}

function fileEntryName(entry: AmpRecord) {
  return pickString(entry, "Name", "Filename", "FileName", "DisplayName", "FullName") ?? "";
}

function fileEntrySize(entry: AmpRecord) {
  return pickNumber(entry, "SizeBytes", "Size", "FileSize", "Length", "Bytes");
}

async function listDirectory(instance: AmpInstance, dir: string) {
  const normalizedDir = normalizeAmpPath(dir);
  const result = await callManagedMethod(instance, "FileManagerPlugin", "GetDirectoryListing", { Dir: normalizedDir });
  return { path: normalizedDir, entries: asArray(result) };
}

async function findFileSize(instance: AmpInstance, filePath: string) {
  const { dir, name } = splitAmpPath(filePath);
  try {
    const listing = await listDirectory(instance, dir);
    const match = listing.entries
      .flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
      .find((entry) => fileEntryName(entry).toLowerCase() === name.toLowerCase());
    return match ? fileEntrySize(match) : undefined;
  } catch {
    return undefined;
  }
}

function chunkToBuffer(result: unknown) {
  const encoded = actionResultValue(result);
  if (typeof encoded !== "string") {
    throw new Error(`AMP returned an unexpected file chunk: ${JSON.stringify(redact(result))}`);
  }
  return Buffer.from(encoded, "base64");
}

async function readFileContent(instance: AmpInstance, filePath: string, maxBytes = defaultMaxReadBytes, chunkSize = defaultFileChunkBytes) {
  const filename = normalizeAmpPath(filePath);
  const size = await findFileSize(instance, filename);
  const chunks: Buffer[] = [];
  let offset = 0;
  let truncated = false;

  while (offset < maxBytes) {
    const requested = Math.min(chunkSize, maxBytes - offset);
    const result = await callManagedMethod(instance, "FileManagerPlugin", "ReadFileChunk", {
      Filename: filename,
      Offset: offset,
      ChunkSize: requested,
    });
    const buffer = chunkToBuffer(result);
    chunks.push(buffer);
    offset += buffer.length;

    if (buffer.length === 0 || buffer.length < requested) break;
    if (size !== undefined && offset >= size) break;
  }

  if (size !== undefined && offset < size) truncated = true;
  if (size === undefined && offset >= maxBytes) truncated = true;

  return { filename, bytesRead: offset, sizeBytes: size ?? null, truncated, buffer: Buffer.concat(chunks) };
}

async function writeFileContent(instance: AmpInstance, filePath: string, content: string, encoding: "utf8" | "base64", chunkSize = defaultFileChunkBytes) {
  const filename = normalizeAmpPath(filePath);
  const buffer = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");

  if (buffer.length === 0) {
    const result = await callManagedMethod(instance, "FileManagerPlugin", "WriteFileChunk", {
      Filename: filename,
      Data: "",
      Offset: 0,
      FinalChunk: true,
    });
    return { filename, bytesWritten: 0, result };
  }

  let offset = 0;
  let lastResult: unknown = null;
  while (offset < buffer.length) {
    const nextOffset = Math.min(offset + chunkSize, buffer.length);
    const chunk = buffer.subarray(offset, nextOffset);
    lastResult = await callManagedMethod(instance, "FileManagerPlugin", "WriteFileChunk", {
      Filename: filename,
      Data: chunk.toString("base64"),
      Offset: offset,
      FinalChunk: nextOffset >= buffer.length,
    });
    offset = nextOffset;
  }

  return { filename, bytesWritten: buffer.length, result: lastResult };
}

async function appendFileContent(instance: AmpInstance, filePath: string, content: string, encoding: "utf8" | "base64") {
  const filename = normalizeAmpPath(filePath);
  const buffer = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
  const result = await callManagedMethod(instance, "FileManagerPlugin", "AppendFileChunk", {
    Filename: filename,
    Data: buffer.toString("base64"),
    Delete: false,
  });
  return { filename, bytesAppended: buffer.length, result };
}

const postCreateActions: Record<string, number> = {
  DoNothing: 0,
  UpdateOnce: 1,
  UpdateAlways: 2,
  UpdateAndStartOnce: 3,
  UpdateAndStartAlways: 4,
  StartAlways: 5,
};

function normalizePostCreate(value: string | number | undefined) {
  if (value === undefined) return postCreateActions.DoNothing;
  if (typeof value === "number") return value;
  const found = postCreateActions[value];
  if (found === undefined) {
    throw new Error(`Unknown postCreate action "${value}". Use one of: ${Object.keys(postCreateActions).join(", ")}`);
  }
  return found;
}

function cleanParams(params: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

function findGuid(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["Id", "ID", "TargetID", "TargetId", "InstanceID", "InstanceId"]) {
    const guid = findGuid(record[key]);
    if (guid) return guid;
  }
  return null;
}

async function resolveTargetAdsInstance(targetADSInstance?: string) {
  if (targetADSInstance) return targetADSInstance;
  const targetInfo = await ampRequest("ADSModule", "GetTargetInfo");
  const targetId = findGuid(targetInfo);
  if (targetId) return targetId;
  throw new Error("Could not auto-detect TargetADSInstance. Pass targetADSInstance explicitly.");
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
    if (moduleName) {
      return textResult({
        moduleName,
        module: cachedSpec[moduleName] ?? null,
        availableModules: Object.keys(cachedSpec),
        refreshed: refresh ?? false,
      });
    }
    return textResult(cachedSpec);
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
    description: "List the AMP instances currently allowed by the MCP policy group, with non-secret diagnostics.",
    inputSchema: {},
  },
  async () => {
    const instances = await getPolicyInstances();
    return textResult({
      baseUrl,
      hasUsername: Boolean(process.env.AMP_USERNAME),
      hasPassword: Boolean(process.env.AMP_PASSWORD),
      hasControllerSession: Boolean(sessionId),
      policyEnabled,
      policyGroup,
      instances,
      warning:
        instances.length === 0
          ? "No instances are visible in the policy group. Check that this MCP process received AMP_BASE_URL plus AMP_USERNAME/AMP_PASSWORD or AMP_SESSION_ID, and that the AMP user can see instances in AMP_POLICY_GROUP."
          : undefined,
    });
  },
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
      "Authenticate using AMP_USERNAME, AMP_PASSWORD, optional AMP_TOKEN, and optional AMP_REMEMBER_ME from the process environment or .env. Credentials are never returned.",
    inputSchema: {},
  },
  async () => {
    const username = process.env.AMP_USERNAME;
    const password = process.env.AMP_PASSWORD;
    if (!username || !password) {
      throw new Error("Set AMP_USERNAME and AMP_PASSWORD in the MCP environment or .env before using amp_login_from_env.");
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
    managedInstance = null;
    managedSessionId = "";
    return textResult({ baseUrl, hasSession: false });
  },
);

server.registerTool(
  "amp_connection_status",
  {
    description: "Show non-secret AMP connection configuration and MCP policy state.",
    inputSchema: {
      checkInstances: z.boolean().optional().describe("Also count visible policy-group instances."),
    },
  },
  async ({ checkInstances }) => {
    const result: AmpRecord = {
      baseUrl,
      hasUsername: Boolean(process.env.AMP_USERNAME),
      hasPassword: Boolean(process.env.AMP_PASSWORD),
      hasToken: Boolean(process.env.AMP_TOKEN),
      hasControllerSession: Boolean(sessionId),
      hasManagedSession: Boolean(managedSessionId),
      policyEnabled,
      policyGroup,
      selected: instanceLabel(managedInstance),
    };

    if (checkInstances) {
      const instances = await getPolicyInstances();
      result.policyInstanceCount = instances.length;
      result.policyInstances = instances.map((instance) => summarizeInstance(instance));
    }

    return textResult(result);
  },
);

server.registerTool(
  "amp_instances",
  {
    description: "List the policy-allowed AMP instances with friendly status summaries.",
    inputSchema: {
      raw: z.boolean().optional().describe("Include raw AMP instance/status payloads."),
    },
  },
  async ({ raw }) => textResult(await summarizePolicyInstances(raw ?? false)),
);

server.registerTool(
  "amp_status",
  {
    description: "Show status for the selected instance, a named instance, or all policy-allowed instances.",
    inputSchema: {
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      all: z.boolean().optional().describe("Show every instance in the policy group."),
      raw: z.boolean().optional().describe("Include raw AMP instance/status payloads when showing all."),
    },
  },
  async ({ instance, all, raw }) => {
    if (all || (!instance && !managedInstance)) return textResult(await summarizePolicyInstances(raw ?? false));
    const selected = await resolvePolicyInstance(instance, true);
    return textResult({ policyGroup, selected: summarizeInstance(selected, findStatusForInstance((await tryGetInstanceStatuses()).statuses, selected), raw ?? false) });
  },
);

server.registerTool(
  "amp_use_instance",
  {
    description: "Select an allowed AMP instance by name/friendly name/ID and prepare its managed API session.",
    inputSchema: {
      instance: z.string().min(1).describe("Instance name, friendly name, or ID. Partial names are okay if unique."),
      startIfStopped: z.boolean().optional().describe("Start the instance first if AMP cannot manage it while stopped."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await resolvePolicyInstance(instance, false);
    const ready = await ensureManagedInstance(selected, { startIfStopped: startIfStopped ?? false, waitTimeoutMs });
    return textResult({
      selected: summarizeInstance(ready.instance, null),
      started: ready.started,
      managed: Boolean(managedInstance),
      hasManagedSession: Boolean(managedSessionId),
      status: ready.status,
    });
  },
);

server.registerTool(
  "amp_start_instance",
  {
    description: "Start a policy-allowed AMP instance by name/friendly name/ID, or the selected instance.",
    inputSchema: {
      instance: z.string().optional(),
      wait: z.boolean().optional().describe("Wait until AMP reports the instance is running. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ instance, wait, waitTimeoutMs }) => {
    const selected = await resolvePolicyInstance(instance, true);
    const result = await startPolicyInstance(selected, wait ?? true, waitTimeoutMs);
    return textResult({ instance: summarizeInstance(selected), ...result });
  },
);

server.registerTool(
  "amp_stop_instance",
  {
    description: "Stop a policy-allowed AMP instance by name/friendly name/ID, or the selected instance.",
    inputSchema: {
      instance: z.string().optional(),
      wait: z.boolean().optional().describe("Wait until AMP reports the instance is stopped. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ instance, wait, waitTimeoutMs }) => {
    const selected = await resolvePolicyInstance(instance, true);
    const result = await stopPolicyInstance(selected, wait ?? true, waitTimeoutMs);
    if (managedInstance && sameInstance(selected, managedInstance)) {
      managedInstance = null;
      managedSessionId = "";
    }
    return textResult({ instance: summarizeInstance(selected), ...result });
  },
);

server.registerTool(
  "amp_restart_instance",
  {
    description: "Restart a policy-allowed AMP instance. If it is stopped, this starts it instead.",
    inputSchema: {
      instance: z.string().optional(),
      wait: z.boolean().optional().describe("Wait until AMP reports the instance is running. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ instance, wait, waitTimeoutMs }) => {
    const selected = await resolvePolicyInstance(instance, true);
    const before = await statusForInstance(selected);
    let result: unknown;

    if (before.running === false) {
      const started = await startPolicyInstance(selected, wait ?? true, waitTimeoutMs);
      return textResult({ instance: summarizeInstance(selected), restarted: false, startedBecauseStopped: true, ...started });
    }

    result = await callAdsMethod("RestartInstance", { InstanceName: instanceNameOrThrow(selected) });
    if (managedInstance && sameInstance(selected, managedInstance)) managedSessionId = "";
    const status = wait ?? true ? await waitForInstanceState(selected, true, waitTimeoutMs) : await statusForInstance(selected);
    return textResult({ instance: summarizeInstance(selected), restarted: true, result, status });
  },
);

server.registerTool(
  "amp_files_list",
  {
    description: "List files/folders for the selected or named policy-allowed instance.",
    inputSchema: {
      path: z.string().optional().describe("AMP file-manager path. Defaults to the instance root."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: dir, instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const listing = await listDirectory(selected, dir ?? ".");
    return textResult({ instance: summarizeInstance(selected), ...listing });
  },
);

server.registerTool(
  "amp_file_read",
  {
    description: "Read a file from the selected or named policy-allowed instance using AMP's file manager.",
    inputSchema: {
      path: z.string().min(1).describe("AMP file-manager path to read."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Return text as utf8 or raw base64. Defaults to utf8."),
      maxBytes: z.number().int().positive().optional().describe("Maximum bytes to return. Defaults to AMP_MAX_READ_BYTES or 1 MiB."),
      chunkSize: z.number().int().positive().optional().describe("Read chunk size in bytes."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: filePath, instance, encoding, maxBytes, chunkSize, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const file = await readFileContent(selected, filePath, maxBytes, chunkSize ?? defaultFileChunkBytes);
    return textResult({
      instance: summarizeInstance(selected),
      path: file.filename,
      encoding: encoding ?? "utf8",
      bytesRead: file.bytesRead,
      sizeBytes: file.sizeBytes,
      truncated: file.truncated,
      content: (encoding ?? "utf8") === "base64" ? file.buffer.toString("base64") : file.buffer.toString("utf8"),
    });
  },
);

server.registerTool(
  "amp_file_write",
  {
    description: "Overwrite a file on the selected or named policy-allowed instance using AMP's file manager.",
    inputSchema: {
      path: z.string().min(1).describe("AMP file-manager path to write."),
      content: z.string().describe("File content. Interpreted as UTF-8 unless encoding is base64."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      encoding: z.enum(["utf8", "base64"]).optional(),
      chunkSize: z.number().int().positive().optional(),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: filePath, content, instance, encoding, chunkSize, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await writeFileContent(selected, filePath, content, encoding ?? "utf8", chunkSize ?? defaultFileChunkBytes);
    return textResult({ instance: summarizeInstance(selected), ...result });
  },
);

server.registerTool(
  "amp_file_append",
  {
    description: "Append text or base64 data to a file on the selected or named policy-allowed instance.",
    inputSchema: {
      path: z.string().min(1).describe("AMP file-manager path to append."),
      content: z.string().describe("Content to append. Interpreted as UTF-8 unless encoding is base64."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      encoding: z.enum(["utf8", "base64"]).optional(),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: filePath, content, instance, encoding, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await appendFileContent(selected, filePath, content, encoding ?? "utf8");
    return textResult({ instance: summarizeInstance(selected), ...result });
  },
);

server.registerTool(
  "amp_file_rename",
  {
    description: "Rename a file on the selected or named policy-allowed instance.",
    inputSchema: {
      path: z.string().min(1).describe("Current AMP file-manager path."),
      newPath: z.string().min(1).describe("New AMP file-manager path."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: filePath, newPath, instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "RenameFile", {
      Filename: normalizeAmpPath(filePath),
      NewFilename: normalizeAmpPath(newPath),
    });
    return textResult({ instance: summarizeInstance(selected), path: normalizeAmpPath(filePath), newPath: normalizeAmpPath(newPath), result });
  },
);

server.registerTool(
  "amp_file_copy",
  {
    description: "Copy a file into another directory on the selected or named policy-allowed instance.",
    inputSchema: {
      path: z.string().min(1).describe("Source AMP file-manager path."),
      targetDirectory: z.string().min(1).describe("Destination directory path."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: filePath, targetDirectory, instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "CopyFile", {
      Origin: normalizeAmpPath(filePath),
      TargetDirectory: normalizeAmpPath(targetDirectory),
    });
    return textResult({ instance: summarizeInstance(selected), path: normalizeAmpPath(filePath), targetDirectory: normalizeAmpPath(targetDirectory), result });
  },
);

server.registerTool(
  "amp_file_trash",
  {
    description: "Move a file to AMP trash on the selected or named policy-allowed instance.",
    inputSchema: {
      path: z.string().min(1).describe("AMP file-manager path to trash."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: filePath, instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const normalizedPath = normalizeAmpPath(filePath);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "TrashFile", { Filename: normalizedPath });
    return textResult({ instance: summarizeInstance(selected), path: normalizedPath, trashed: true, result });
  },
);

server.registerTool(
  "amp_directory_create",
  {
    description: "Create a directory on the selected or named policy-allowed instance.",
    inputSchema: {
      path: z.string().min(1).describe("AMP file-manager directory path to create."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: dirPath, instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const normalizedPath = normalizeAmpPath(dirPath);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "CreateDirectory", { NewPath: normalizedPath });
    return textResult({ instance: summarizeInstance(selected), path: normalizedPath, result });
  },
);

server.registerTool(
  "amp_directory_rename",
  {
    description: "Rename a directory on the selected or named policy-allowed instance.",
    inputSchema: {
      path: z.string().min(1).describe("Current AMP file-manager directory path."),
      newName: z.string().min(1).describe("New directory name only, not a full path."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: dirPath, newName, instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "RenameDirectory", {
      oldDirectory: normalizeAmpPath(dirPath),
      NewDirectoryName: newName,
    });
    return textResult({ instance: summarizeInstance(selected), path: normalizeAmpPath(dirPath), newName, result });
  },
);

server.registerTool(
  "amp_directory_trash",
  {
    description: "Move a directory to AMP trash on the selected or named policy-allowed instance.",
    inputSchema: {
      path: z.string().min(1).describe("AMP file-manager directory path to trash."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ path: dirPath, instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const normalizedPath = normalizeAmpPath(dirPath);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "TrashDirectory", { DirectoryName: normalizedPath });
    return textResult({ instance: summarizeInstance(selected), path: normalizedPath, trashed: true, result });
  },
);

server.registerTool(
  "amp_console_read",
  {
    description: "Read recent console/status updates from the selected or named policy-allowed instance.",
    inputSchema: {
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    return textResult({ instance: summarizeInstance(selected), updates: await callManagedMethod(selected, "Core", "GetUpdates") });
  },
);

server.registerTool(
  "amp_console_send",
  {
    description: "Send a console command/message to the selected or named policy-allowed instance.",
    inputSchema: {
      message: z.string().min(1),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    },
  },
  async ({ message, instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "Core", "SendConsoleMessage", { message });
    return textResult({ instance: summarizeInstance(selected), sent: message, result });
  },
);

server.registerTool(
  "amp_supported_apps",
  {
    description: "List AMP-supported application modules that can be used when creating instances.",
    inputSchema: {
      full: z.boolean().optional().describe("Return full application records instead of summaries."),
    },
  },
  async ({ full }) => {
    const method = full ? "GetSupportedApplications" : "GetSupportedAppSummaries";
    return textResult(await ampRequest("ADSModule", method));
  },
);

server.registerTool(
  "amp_create_instance",
  {
    description: `Create a new AMP instance in the configured policy group (${policyGroup}). Auto-configured by default.`,
    inputSchema: {
      module: z.string().min(1).describe("AMP module name, for example Minecraft, Valheim, or any module reported by amp_supported_apps."),
      friendlyName: z.string().min(1).describe("Human-friendly display name for the new instance."),
      instanceName: z.string().optional().describe("Internal instance name. Defaults to a safe name generated from friendlyName."),
      targetADSInstance: z.string().optional().describe("Target ADS instance GUID. Auto-detected when possible."),
      newInstanceId: z.string().optional().describe("New instance GUID. Generated when omitted."),
      autoConfigure: z.boolean().optional().describe("Let AMP choose ports/settings. Defaults to true."),
      ipBinding: z.string().optional().describe("Used when autoConfigure is false. Defaults to 0.0.0.0."),
      portNumber: z.number().int().nonnegative().optional().describe("Used when autoConfigure is false."),
      adminUsername: z.string().optional().describe("Module admin username if the app requires one. Defaults to admin."),
      adminPassword: z.string().optional().describe("Module admin password if the app requires one. Generated when omitted."),
      provisionSettings: z.record(z.string(), z.string()).optional(),
      postCreate: z.union([z.enum(["DoNothing", "UpdateOnce", "UpdateAlways", "UpdateAndStartOnce", "UpdateAndStartAlways", "StartAlways"]), z.number().int()]).optional(),
      startOnBoot: z.boolean().optional(),
      displayImageSource: z.string().optional(),
      targetDatastore: z.number().int().optional(),
    },
  },
  async (args) => {
    const autoConfigure = args.autoConfigure ?? true;
    if (!autoConfigure && args.portNumber === undefined) {
      throw new Error("portNumber is required when autoConfigure is false.");
    }

    const safeName =
      args.instanceName ??
      `${args.friendlyName.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 40) || "AMPInstance"}${randomUUID().slice(0, 8)}`;
    const targetADSInstance = await resolveTargetAdsInstance(args.targetADSInstance);
    const body = cleanParams({
      TargetADSInstance: targetADSInstance,
      NewInstanceId: args.newInstanceId ?? randomUUID(),
      Module: args.module,
      InstanceName: safeName,
      FriendlyName: args.friendlyName,
      IPBinding: args.ipBinding ?? "0.0.0.0",
      PortNumber: args.portNumber ?? 0,
      AdminUsername: args.adminUsername ?? "admin",
      AdminPassword: args.adminPassword ?? randomUUID(),
      ProvisionSettings: args.provisionSettings ?? {},
      AutoConfigure: autoConfigure,
      PostCreate: normalizePostCreate(args.postCreate),
      StartOnBoot: args.startOnBoot ?? false,
      DisplayImageSource: args.displayImageSource,
      TargetDatastore: args.targetDatastore,
      Group: policyGroup,
    });

    const result = await callAdsMethod("CreateInstance", body);
    return textResult({
      policyGroup,
      instanceName: safeName,
      friendlyName: args.friendlyName,
      module: args.module,
      targetADSInstance,
      result,
      note: `The MCP policy forces this instance into display group "${policyGroup}".`,
    });
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
    const { meta, refreshed, refreshError } = await resolveMethodMeta(moduleName, methodName);
    if (!meta) {
      if (moduleName.toLowerCase() === "amp_api_spec") {
        throw new Error("amp_api_spec is an MCP tool, not an AMP API module. Call the amp_api_spec tool directly.");
      }
      const refreshHint = refreshError ? ` Live spec refresh failed: ${refreshError}` : "";
      throw new Error(
        `Unknown AMP method "${moduleName}/${methodName}" in the bundled${refreshed ? " and refreshed" : ""} API spec.${refreshHint} Call the amp_api_spec tool directly to inspect available modules/methods.`,
      );
    }
    if (requiresConfirmation(moduleName, methodName) && !confirm) {
      throw new Error(`Refusing to call state-changing method ${moduleName}/${methodName} without confirm: true.`);
    }
    const body = normalizeParams(meta, params ?? {});
    const policyBody = await assertPolicyAllows(moduleName, methodName, body);
    const useManagedRoute = Boolean(managedInstance && moduleName !== "ADSModule");
    const result = await ampRequest(moduleName, methodName, policyBody, useManagedRoute ? managedInstance : null);
    await updateManagedInstance(moduleName, methodName, policyBody, result);
    assertAmpAccepted(`${moduleName}/${methodName}`, result);
    return textResult(result);
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
      throw new Error("Set AMP_USERNAME and AMP_PASSWORD in the MCP environment or .env to run --self-test-login.");
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
