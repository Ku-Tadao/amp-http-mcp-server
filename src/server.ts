#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import fallbackSpec from "./amp-api-spec.json" with { type: "json" };

type AmpParameter = {
  Name: string;
  TypeName: string;
  Description?: string;
  Optional: boolean;
  ParamEnumValues?: Record<string, string | number> | null;
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
type AuthRetryState = { failures: number; retryAt: number };

class AmpAuthenticationRejectedError extends Error {
  override name = "AmpAuthenticationRejectedError";
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
loadEnvFile(path.join(projectRoot, ".env"));

let baseUrl = normalizeBaseUrl(process.env.AMP_BASE_URL ?? "https://amp.example.com");
let sessionId = process.env.AMP_SESSION_ID ?? "";
let loginCredentials = {
  username: process.env.AMP_USERNAME ?? "",
  password: process.env.AMP_PASSWORD ?? "",
  token: process.env.AMP_TOKEN ?? "",
};
let cachedSpec: AmpSpec = fallbackSpec as AmpSpec;
let policyEnabled = process.env.AMP_POLICY_ENABLED !== "false";
let policyGroup = process.env.AMP_POLICY_GROUP ?? "AI";
const policyLocked = process.env.AMP_POLICY_LOCKED !== "false";
const protectedInstanceSelectors = new Set(
  (process.env.AMP_PROTECTED_INSTANCES ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
let managedInstance: AmpInstance | null = null;
const managedSessions = new Map<string, string>();
let controllerLoginPromise: Promise<void> | null = null;
const managedLoginPromises = new Map<string, Promise<void>>();
const controllerAuthRetry: AuthRetryState = { failures: 0, retryAt: 0 };
const managedAuthRetries = new Map<string, AuthRetryState>();

function positiveEnvNumber(name: string, fallback: number, integer = false, max = Number.POSITIVE_INFINITY) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive${integer ? " integer" : " number"}${Number.isFinite(max) ? ` no greater than ${max}` : ""}.`);
  }
  return value;
}

const defaultWaitTimeoutMs = positiveEnvNumber("AMP_WAIT_TIMEOUT_MS", 120000);
const defaultPollMs = positiveEnvNumber("AMP_POLL_MS", 3000);
const defaultManagedLoginTimeoutMs = positiveEnvNumber("AMP_MANAGED_LOGIN_TIMEOUT_MS", 90000);
const defaultFileChunkBytes = positiveEnvNumber("AMP_FILE_CHUNK_BYTES", 524288, true);
const defaultMaxReadBytes = positiveEnvNumber("AMP_MAX_READ_BYTES", 1048576, true);
const defaultHttpTimeoutMs = positiveEnvNumber("AMP_HTTP_TIMEOUT_MS", 30000, true, 4294967295);
const authRetryBaseMs = positiveEnvNumber("AMP_AUTH_RETRY_BASE_MS", 60000, true, 4294967295);
const authRetryMaxMs = positiveEnvNumber("AMP_AUTH_RETRY_MAX_MS", 900000, true, 4294967295);
// How long amp_create_instance waits for a new instance to become visible before
// applying the configuration AMP drops during provisioning.
const postCreateConfigTimeoutMs = positiveEnvNumber("AMP_POST_CREATE_CONFIG_TIMEOUT_MS", 60000, true, 4294967295);
if (authRetryMaxMs < authRetryBaseMs) {
  throw new Error("AMP_AUTH_RETRY_MAX_MS must be greater than or equal to AMP_AUTH_RETRY_BASE_MS.");
}

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

function redactErrorText(value: string) {
  let output = value;
  for (const secret of [sessionId, ...managedSessions.values(), loginCredentials.password, loginCredentials.token]) {
    if (secret) output = output.replaceAll(secret, "<redacted>");
  }
  return output.slice(0, 2000);
}

function assertAuthRetryAllowed(label: string, state: AuthRetryState) {
  const remainingMs = state.retryAt - Date.now();
  if (remainingMs > 0) {
    throw new Error(
      `${label} login is cooling down after ${state.failures} consecutive authentication rejection${state.failures === 1 ? "" : "s"}. Retry in ${Math.ceil(remainingMs / 1000)} seconds, or correct the credentials and call amp_clear_session to reset the cooldown.`,
    );
  }
}

function recordAuthRejection(state: AuthRetryState) {
  state.failures += 1;
  state.retryAt = Date.now() + Math.min(authRetryMaxMs, authRetryBaseMs * 2 ** Math.min(state.failures - 1, 20));
}

function clearAuthRetry(state: AuthRetryState) {
  state.failures = 0;
  state.retryAt = 0;
}

function isAuthenticationRejection(error: unknown) {
  return error instanceof AmpAuthenticationRejectedError || (error instanceof Error && /AMP HTTP (401|403|429)\b/.test(error.message));
}

function findMethodMeta(moduleName: string, methodName: string) {
  return cachedSpec[moduleName]?.[methodName] ?? null;
}

// An application instance exposes its own modules (MinecraftModule, GenericModule,
// srcdsModule, ...) that the ADS controller spec never lists. Cache the managed
// instance's spec keyed by instance ID so switching instances invalidates it.
const managedSpecs = new Map<string, AmpSpec>();

function resetConnectionState(clearControllerSession = true) {
  if (clearControllerSession) sessionId = "";
  cachedSpec = fallbackSpec as AmpSpec;
  controllerLoginPromise = null;
  clearAuthRetry(controllerAuthRetry);
  managedInstance = null;
  managedSessions.clear();
  managedLoginPromises.clear();
  managedAuthRetries.clear();
  managedSpecs.clear();
  loginCredentials = {
    username: process.env.AMP_USERNAME ?? "",
    password: process.env.AMP_PASSWORD ?? "",
    token: process.env.AMP_TOKEN ?? "",
  };
}

async function getManagedSpec(instance = managedInstance) {
  if (!instance) return null;
  const id = instanceIdOf(instance);
  if (!id) return null;
  const cached = managedSpecs.get(id);
  if (cached) return cached;
  const spec = (await ampRequest("Core", "GetAPISpec", {}, instance)) as AmpSpec;
  // An unauthenticated instance returns a stub Core module holding only the login
  // methods. Caching that stub makes every later call fail with "Unknown AMP
  // method", long after the session recovered, so only cache a real spec.
  if (isAuthenticatedSpec(spec)) managedSpecs.set(id, spec);
  return spec;
}

// Core/GetStatus is present for any authenticated session and absent from the
// pre-login stub, which advertises only Login/GetAPISpec and friends.
function isAuthenticatedSpec(spec: AmpSpec | null | undefined) {
  return Boolean(spec?.Core?.GetStatus);
}

// AMP's bulk setters (Core/SetConfigs and friends) answer a refused write with a
// bare `false` and no reason, which reads as success to anything that only checks
// for an error object. Turn it into the failure it is, and point at the singular
// form, which does return AMP's actual reason.
function assertSetterApplied(moduleName: string, methodName: string, result: unknown) {
  if (result !== false || !/^Set[A-Z]/.test(methodName)) return;
  const singular = methodName.endsWith("s") ? methodName.slice(0, -1) : "";
  const retry = singular
    ? ` Retry one value at a time with ${moduleName}/${singular} to get AMP's reason.`
    : "";
  throw new Error(
    `AMP rejected ${moduleName}/${methodName}: it returned false and applied nothing, without saying why.${retry} The usual cause is that this AMP user's role lacks the Settings.* permission for these nodes; only a super admin can grant it, or make the change from the AMP web UI.`,
  );
}

async function resolveMethodMeta(moduleName: string, methodName: string, instance: AmpInstance | null) {
  if (instance) {
    try {
      const spec = await getManagedSpec(instance);
      return { meta: spec?.[moduleName]?.[methodName] ?? null, refreshed: true, refreshError: "" };
    } catch (error) {
      return { meta: null, refreshed: false, refreshError: error instanceof Error ? error.message : String(error) };
    }
  }

  let meta = findMethodMeta(moduleName, methodName);
  if (meta) return { meta, refreshed: false, refreshError: "" };

  try {
    await ensureSession("Core", "GetAPISpec");
    cachedSpec = await refreshControllerSpec();
    meta = findMethodMeta(moduleName, methodName);
    if (meta) return { meta, refreshed: true, refreshError: "" };

    return { meta: null, refreshed: true, refreshError: "" };
  } catch (error) {
    return {
      meta: null,
      refreshed: false,
      refreshError: error instanceof Error ? error.message : String(error),
    };
  }
}

function coerceValue(parameter: AmpParameter, value: unknown) {
  if (value === null && parameter.TypeName.startsWith("Nullable<")) return null;
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
  if (["adsmodule/gettargetpairingcode", "core/getremotelogintoken"].includes(name)) return true;
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

async function loginControllerWithBackoff(params: { username: string; password: string; token: string; rememberMe: boolean }) {
  assertAuthRetryAllowed("Controller", controllerAuthRetry);
  try {
    const result = await loginAndRefresh(params);
    clearAuthRetry(controllerAuthRetry);
    return result;
  } catch (error) {
    if (isAuthenticationRejection(error)) recordAuthRejection(controllerAuthRetry);
    throw error;
  }
}

async function ensureSession(moduleName: string, methodName: string) {
  if (shouldSkipEnvLogin(moduleName, methodName)) return;
  if (controllerLoginPromise) return controllerLoginPromise;

  const { username, password, token } = loginCredentials;
  if (!username || !password) return;

  controllerLoginPromise = loginControllerWithBackoff({ username, password, token, rememberMe: process.env.AMP_REMEMBER_ME === "true" }).then(
    () => undefined,
  );
  try {
    await controllerLoginPromise;
  } finally {
    controllerLoginPromise = null;
  }
}

function instanceIdOf(instance: AmpInstance | null) {
  return instance?.InstanceID ?? instance?.InstanceId ?? "";
}

async function ensureManagedSession(instance: AmpInstance, timeoutMs = defaultManagedLoginTimeoutMs) {
  const id = instanceIdOf(instance);
  if (!id) throw new Error("Cannot create a managed session without an instance ID.");
  if (managedSessions.has(id)) return;
  const inFlight = managedLoginPromises.get(id);
  if (inFlight) return inFlight;
  const authRetry = managedAuthRetries.get(id) ?? { failures: 0, retryAt: 0 };
  managedAuthRetries.set(id, authRetry);
  assertAuthRetryAllowed(`Managed instance "${instanceLabel(instance)}"`, authRetry);

  const login = (async () => {
    const { username, password, token } = loginCredentials;
    if (!username || !password) {
      throw new Error("Managed instance API calls require AMP_USERNAME and AMP_PASSWORD.");
    }

    const deadline = Date.now() + timeoutMs;
    let lastError = "";

    while (Date.now() <= deadline) {
      try {
        const result = await ampRequest("Core", "Login", { username, password, token, rememberMe: false }, instance);
        if (isAmpError(result) || isActionFailure(result)) {
          managedSessions.delete(id);
          throw new AmpAuthenticationRejectedError(
            `AMP rejected managed Core/Login: ${getAmpErrorMessage(result) || actionMessage(result) || "authentication failed"}`,
          );
        }
        if (managedSessions.has(id)) {
          managedAuthRetries.delete(id);
          return;
        }
        throw new AmpAuthenticationRejectedError("AMP accepted managed Core/Login but returned no session ID.");
      } catch (error) {
        if (isAuthenticationRejection(error)) {
          recordAuthRejection(authRetry);
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(defaultPollMs);
    }

    const name = instance.FriendlyName ?? instance.InstanceName ?? instanceIdOf(instance);
    throw new Error(`Could not log in to managed AMP instance "${name}" within ${timeoutMs}ms. Last response: ${lastError}`);
  })();
  managedLoginPromises.set(id, login);
  try {
    await login;
  } finally {
    managedLoginPromises.delete(id);
  }
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
    const managedSessionId = managedSessions.get(id) ?? "";

    const url = `${baseUrl}/API/ADSModule/Servers/${encodeURIComponent(id)}/API/${encodeURIComponent(moduleName)}/${encodeURIComponent(methodName)}`;
    const body = { ...params, SESSIONID: managedSessionId };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${managedSessionId || sessionId}`,
      },
      signal: AbortSignal.timeout(defaultHttpTimeoutMs),
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
      managedSessions.set(id, authHeader.slice("Bearer ".length));
    }
    if (data && typeof data === "object" && "sessionID" in data && typeof data.sessionID === "string") {
      managedSessions.set(id, data.sessionID);
    }

    if (!response.ok) {
      throw new Error(`AMP HTTP ${response.status}: ${redactErrorText(text)}`);
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
    signal: AbortSignal.timeout(defaultHttpTimeoutMs),
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
    throw new Error(`AMP HTTP ${response.status}: ${redactErrorText(text)}`);
  }

  return data;
}

function asAmpSpec(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AMP returned an invalid API spec.");
  }
  const spec = value as AmpSpec;
  if (!spec.Core?.GetAPISpec) {
    throw new Error("AMP returned an incomplete API spec; keeping the existing authenticated/fallback catalog.");
  }
  return spec;
}

async function refreshControllerSpec() {
  if (!sessionId) {
    throw new Error("Authenticate before refreshing the full AMP API spec.");
  }
  const result = await ampRequest("Core", "GetAPISpec");
  assertAmpAccepted("Core/GetAPISpec", result);
  return asAmpSpec(result);
}

async function loginAndRefresh(params: { username: string; password: string; token: string; rememberMe: boolean }) {
  let result: unknown;
  try {
    result = await ampRequest("Core", "Login", params);
  } catch (error) {
    if (isAuthenticationRejection(error)) {
      sessionId = "";
      throw new AmpAuthenticationRejectedError(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
  if (isAmpError(result) || isActionFailure(result)) {
    sessionId = "";
    throw new AmpAuthenticationRejectedError(
      `AMP rejected Core/Login: ${getAmpErrorMessage(result) || actionMessage(result) || "authentication failed"}`,
    );
  }
  if (!sessionId) throw new AmpAuthenticationRejectedError("AMP accepted Core/Login but returned no session ID.");
  loginCredentials = { username: params.username, password: params.password, token: params.token };
  cachedSpec = await refreshControllerSpec();
  return result;
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
    throw new Error(`AMP rejected ${context}: ${message}${permissionHint(context, message)}`);
  }
}

// AMP's permission denials are inconsistent: method-level ones name the node they
// want, but setting-level ones ("does not have permission to modify setting 'X'")
// name nothing an operator can act on. Say what to grant, in both cases.
function permissionHint(context: string, message: string) {
  if (!/\bpermission\b/i.test(message)) return "";

  const [moduleName, methodName] = context.split("/");
  const settingNode = /modify setting '([^']+)'/i.exec(message)?.[1];
  const required = findMethodMeta(moduleName ?? "", methodName ?? "")?.RequiredPermissions ?? [];

  const needs = settingNode
    ? `The AMP user's role needs the Settings.* node covering "${settingNode}" (writing instance settings is a separate grant from starting/updating the app).`
    : required.length
      ? `The AMP user's role needs ${required.join(" and ")}.`
      : "The AMP user's role is missing a permission node for this call.";
  return ` [permissions] ${needs} Only an AMP super admin can grant it (Configuration > Role Management); otherwise do this step from the AMP web UI. Core/CurrentSessionHasPermission answers only for the session it runs on, so a managed-instance call reports false for controller-scoped ADS.* nodes even when the controller session holds them - do not read that as proof the account lacks an ADS permission.`;
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

// ADSModule/GetInstances only reports instances the AMP user holds an explicit
// Instances.<id>.Manage grant on, so a display group can look empty even when it
// has members. Name those members so the fix (grant Manage) is obvious.
async function explainEmptyPolicyGroup() {
  const base =
    "No instances are visible in the policy group. Check that this MCP process received AMP_BASE_URL plus AMP_USERNAME/AMP_PASSWORD or AMP_SESSION_ID, and that the AMP user can see instances in AMP_POLICY_GROUP.";
  let unmanageable: string[] = [];
  try {
    unmanageable = asArray(await ampRequest("ADSModule", "GetLocalInstances"))
      .filter((instance): instance is AmpInstance => Boolean(instance && typeof instance === "object"))
      .filter((instance) => (instance.Group ?? "") === policyGroup)
      .map((instance) => `${instance.InstanceName ?? instanceIdOf(instance)} (${instanceIdOf(instance)})`);
  } catch {
    // GetLocalInstances is only used to enrich this message; ignore if unavailable.
  }
  if (unmanageable.length === 0) return base;
  return `${base} Display group "${policyGroup}" does contain ${unmanageable.join(", ")}, but this AMP user has no Instances.<id>.Manage grant for them, so ADSModule/GetInstances hides them. Grant Manage on those instances to the AMP user.`;
}

async function getPolicyInstances() {
  const instances = await getKnownInstances();
  return instances.filter((instance) => (instance.Group ?? "") === policyGroup);
}

function getParam(params: Record<string, unknown>, ...names: string[]) {
  const found = Object.entries(params).find(([key]) => names.some((name) => key.toLowerCase() === name.toLowerCase()));
  return found?.[1];
}

async function assertPolicyAllows(
  moduleName: string,
  methodName: string,
  params: Record<string, unknown>,
  managedContext: AmpInstance | null = managedInstance,
) {
  if (!policyEnabled) return params;

  const callName = `${moduleName}/${methodName}`.toLowerCase();
  const stateChanging = requiresConfirmation(moduleName, methodName);
  if (moduleName === "FileManagerPlugin") {
    if (!managedContext) {
      throw new Error(
        `Policy blocked ${moduleName}/${methodName}: call ADSModule/ManageInstance for an instance in display group "${policyGroup}" first.`,
      );
    }

    const moduleInfo = await ampRequest("Core", "GetModuleInfo", {}, managedContext);
    const currentInstanceId =
      moduleInfo && typeof moduleInfo === "object" && "InstanceId" in moduleInfo
        ? String(moduleInfo.InstanceId)
        : "";
    const policyInstances = await getPolicyInstances();
    const allowed = policyInstances.find((instance) => {
      const id = instance.InstanceID ?? instance.InstanceId;
      return id && String(id).toLowerCase() === currentInstanceId.toLowerCase();
    });

    if (!allowed) {
      if (managedContext) {
        throw new Error(
          `Policy blocked ${moduleName}/${methodName}: AMP returned a management handoff for "${managedContext.InstanceName}", but the controller API did not switch into a usable instance session. Direct/proxied instance API access is required before file-manager calls can be made safely.`,
        );
      }
      throw new Error(
        `Policy blocked ${moduleName}/${methodName}: file-manager calls are only allowed on instances in display group "${policyGroup}".`,
      );
    }

    if (stateChanging && isProtectedInstance(allowed)) {
      throw new Error(`Policy blocked ${moduleName}/${methodName}: "${instanceLabel(allowed)}" is protected by AMP_PROTECTED_INSTANCES.`);
    }

    return params;
  }

  if (moduleName !== "ADSModule") {
    if (!managedContext) {
      if (stateChanging) {
        throw new Error(`Policy blocked controller-wide state-changing call ${moduleName}/${methodName}; select an allowed instance first.`);
      }
      return params;
    }

    const current = (await getPolicyInstances()).find((instance) => sameInstance(instance, managedContext));
    if (!current) {
      throw new Error(`Policy blocked ${moduleName}/${methodName}: the selected instance is no longer in display group "${policyGroup}".`);
    }
    if (stateChanging && isProtectedInstance(current)) {
      throw new Error(`Policy blocked ${moduleName}/${methodName}: "${instanceLabel(current)}" is protected by AMP_PROTECTED_INSTANCES.`);
    }
    return params;
  }

  if (["adsmodule/createinstance", "adsmodule/createinstancefromspec"].includes(callName)) {
    return { ...params, Group: policyGroup };
  }

  const targetId = getParam(params, "InstanceID", "InstanceId", "instanceId", "SourceInstanceId");
  const targetName = getParam(params, "InstanceName", "instanceName");
  if (!targetId && !targetName) {
    if (stateChanging) {
      throw new Error(`Policy blocked global or aggregate state-changing call ${moduleName}/${methodName}; it cannot be scoped to display group "${policyGroup}".`);
    }
    return params;
  }

  const policyInstances = await getPolicyInstances();
  const allowed = policyInstances.find((instance) => {
    const id = instance.InstanceID ?? instance.InstanceId;
    return (
      (targetId && String(id).toLowerCase() === String(targetId).toLowerCase()) ||
      (targetName && String(instance.InstanceName).toLowerCase() === String(targetName).toLowerCase())
    );
  });

  if (!allowed) {
    throw new Error(`Policy blocked ${moduleName}/${methodName}: target is not in display group "${policyGroup}".`);
  }

  if (stateChanging && callName !== "adsmodule/manageinstance" && isProtectedInstance(allowed)) {
    throw new Error(`Policy blocked ${moduleName}/${methodName}: "${instanceLabel(allowed)}" is protected by AMP_PROTECTED_INSTANCES.`);
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

function isProtectedInstance(instance: AmpInstance | null | undefined) {
  return Boolean(instance && matchFields(instance).some((field) => protectedInstanceSelectors.has(field.toLowerCase())));
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
  if (/(running|ready|idle|online|available)/.test(state)) return true;
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
    protected: isProtectedInstance(instance),
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

// AMP's CreateInstance takes a FriendlyName and then, on the autoConfigure path,
// stores the internal instance name instead. Anything else AMP decides for itself
// during provisioning is silently dropped the same way, so treat creation as
// "make the instance exist" only and apply configuration once it does.
async function applyPostCreateConfig(
  instanceId: string,
  wanted: { friendlyName: string; description?: string; displayImageSource?: string },
  timeoutMs: number,
) {
  const instance = await waitForInstanceVisible(instanceId, timeoutMs);
  if (!instance) {
    return {
      status: "deferred",
      detail:
        "The instance did not become visible before the timeout, so nothing was applied. It is still provisioning; re-apply with ADSModule/UpdateInstanceInfo once amp_instances lists it.",
    };
  }

  if ((instance.FriendlyName ?? "") === wanted.friendlyName && !wanted.description && !wanted.displayImageSource) {
    return { status: "not needed", detail: "AMP kept the requested friendly name." };
  }

  try {
    await callAdsMethod("UpdateInstanceInfo", {
      InstanceId: instanceId,
      FriendlyName: wanted.friendlyName,
      Description: wanted.description ?? "",
      DisplayImageSource: wanted.displayImageSource,
    });
    return {
      status: "applied",
      detail: `AMP stored the friendly name as "${instance.FriendlyName ?? ""}" during creation; corrected to "${wanted.friendlyName}".`,
    };
  } catch (error) {
    return {
      status: "failed",
      detail: `${error instanceof Error ? error.message : String(error)} The instance exists and works; only its display name is wrong.`,
    };
  }
}

async function waitForInstanceVisible(instanceId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const found = (await getPolicyInstances()).find((instance) => instanceIdOf(instance) === instanceId);
      if (found) return found;
    } catch {
      // A create can briefly unsettle the controller; keep polling until the deadline.
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
  }
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
  const policyBody = await assertPolicyAllows(moduleName, methodName, params, instance);
  const result = await ampRequest(moduleName, methodName, policyBody, instance);
  assertAmpAccepted(`${moduleName}/${methodName}`, result);
  return result;
}

async function waitForInstanceState(
  instance: AmpInstance,
  desiredRunning: boolean,
  timeoutMs = defaultWaitTimeoutMs,
  deadline = Date.now() + timeoutMs,
) {
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

async function startPolicyInstance(
  instance: AmpInstance,
  wait = true,
  timeoutMs = defaultWaitTimeoutMs,
  deadline?: number,
  force = false,
) {
  if (!force) {
    const before = await statusForInstance(instance);
    if (before.running === true) return { alreadyRunning: true, status: before };
  }

  const result = await callAdsMethod("StartInstance", { InstanceName: instanceNameOrThrow(instance) });
  if (!wait) return { alreadyRunning: false, result, status: await statusForInstance(instance) };
  return { alreadyRunning: false, result, status: await waitForInstanceState(instance, true, timeoutMs, deadline) };
}

async function stopPolicyInstance(
  instance: AmpInstance,
  wait = true,
  timeoutMs = defaultWaitTimeoutMs,
  deadline?: number,
) {
  const before = await statusForInstance(instance);
  if (before.running === false) return { alreadyStopped: true, status: before };

  const result = await callAdsMethod("StopInstance", { InstanceName: instanceNameOrThrow(instance) });
  if (!wait) return { alreadyStopped: false, result, status: await statusForInstance(instance) };
  return { alreadyStopped: false, result, status: await waitForInstanceState(instance, false, timeoutMs, deadline) };
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
    managedInstance = instance;
    await ensureManagedSession(instance, waitTimeoutMs);
    return { instance, started, manageResult: result, status: await statusForInstance(instance) };
  } catch (error) {
    if (!options.startIfStopped || !shouldRetryManageAfterStart(error)) throw error;
    await startPolicyInstance(instance, true, waitTimeoutMs);
    started = true;
    const result = await callAdsMethod("ManageInstance", { InstanceId: instanceIdOf(instance) });
    managedInstance = instance;
    await ensureManagedSession(instance, waitTimeoutMs);
    return { instance, started, manageResult: result, status: await statusForInstance(instance) };
  }
}

async function managedInstanceFor(query?: string, startIfStopped = true, waitTimeoutMs = defaultWaitTimeoutMs) {
  const instance = await resolvePolicyInstance(query, true);
  const ready = await ensureManagedInstance(instance, { startIfStopped, waitTimeoutMs });
  return ready.instance;
}

// AMP's file manager treats "" as the instance root. "." returns an empty listing on at
// least some modules, which silently broke both root directory listings and the size
// lookup used when reading root-level files such as server.properties.
function normalizeAmpPath(value: string | undefined, fallback = "") {
  const parts = (value?.trim() || fallback)
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new Error("AMP file-manager paths cannot contain '..'.");
  return parts.join("/");
}

function requiredAmpPath(value: string, label = "path") {
  const normalized = normalizeAmpPath(value);
  if (!normalized) throw new Error(`${label} must identify a file or directory, not the instance root.`);
  return normalized;
}

function contentBuffer(content: string, encoding: "utf8" | "base64") {
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  const compact = content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new Error("content is not valid base64.");
  }
  return Buffer.from(compact, "base64");
}

function splitAmpPath(filePath: string) {
  const filename = normalizeAmpPath(filePath);
  const separator = filename.lastIndexOf("/");
  if (separator === -1) return { dir: "", name: filename };
  return { dir: filename.slice(0, separator), name: filename.slice(separator + 1) };
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
  const filename = requiredAmpPath(filePath);
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

async function writeBufferContent(instance: AmpInstance, filename: string, buffer: Buffer, chunkSize = defaultFileChunkBytes) {
  const normalizedFilename = requiredAmpPath(filename);

  if (buffer.length === 0) {
    const result = await callManagedMethod(instance, "FileManagerPlugin", "WriteFileChunk", {
      Filename: normalizedFilename,
      Data: "",
      Offset: 0,
      FinalChunk: true,
    });
    return { filename: normalizedFilename, bytesWritten: 0, result };
  }

  let offset = 0;
  let lastResult: unknown = null;
  while (offset < buffer.length) {
    const nextOffset = Math.min(offset + chunkSize, buffer.length);
    const chunk = buffer.subarray(offset, nextOffset);
    lastResult = await callManagedMethod(instance, "FileManagerPlugin", "WriteFileChunk", {
      Filename: normalizedFilename,
      Data: chunk.toString("base64"),
      Offset: offset,
      FinalChunk: nextOffset >= buffer.length,
    });
    offset = nextOffset;
  }

  return { filename: normalizedFilename, bytesWritten: buffer.length, result: lastResult };
}

async function writeFileContent(instance: AmpInstance, filePath: string, buffer: Buffer, chunkSize = defaultFileChunkBytes) {
  const filename = requiredAmpPath(filePath);
  return writeBufferContent(instance, filename, buffer, chunkSize);
}

// AMP offers no working append primitive, verified against 2.7.2:
//   - FileManagerPlugin/AppendFileChunk returns Void and is a silent no-op; the call
//     succeeds and the file is unchanged.
//   - WriteFileChunk recreates the file, so writing at a non-zero Offset zero-fills
//     everything before it rather than preserving the existing bytes.
// So read the current contents and rewrite the file with the new data concatenated,
// refusing rather than truncating when the file is too large to read back in full.
async function appendFileContent(instance: AmpInstance, filePath: string, buffer: Buffer) {
  const filename = requiredAmpPath(filePath);
  if (buffer.length === 0) return { filename, bytesAppended: 0, previousBytes: null, totalBytes: null, result: null };

  // A file absent from its directory listing is a create, not an append.
  const size = await findFileSize(instance, filename);
  if (size === undefined) {
    const created = await writeBufferContent(instance, filename, buffer);
    return { filename, bytesAppended: buffer.length, previousBytes: 0, totalBytes: created.bytesWritten, created: true, result: created.result };
  }

  const existing = await readFileContent(instance, filename, defaultMaxReadBytes);
  if (existing.truncated) {
    throw new Error(
      `Refusing to append to "${filename}": it is ${existing.sizeBytes ?? "more than"} bytes, larger than the ${defaultMaxReadBytes} byte read limit. AMP has no true append, so this tool must rewrite the whole file and would lose the unread remainder. Raise AMP_MAX_READ_BYTES to append to it.`,
    );
  }

  const written = await writeBufferContent(instance, filename, Buffer.concat([existing.buffer, buffer]));
  return {
    filename,
    bytesAppended: buffer.length,
    previousBytes: existing.bytesRead,
    totalBytes: written.bytesWritten,
    result: written.result,
  };
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

function directGuid(value: unknown): string | null {
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  return null;
}

function findGuid(value: unknown): string | null {
  const direct = directGuid(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["Id", "ID", "TaskId", "TaskID", "TargetID", "TargetId", "InstanceID", "InstanceId", "Result"]) {
    const guid = findGuid(record[key]);
    if (guid) return guid;
  }
  return null;
}

function taskIdFromResult(value: unknown): string | null {
  const direct = directGuid(value);
  if (direct) return direct;
  const record = asRecord(value);
  if (!record) return null;

  for (const key of ["TaskId", "TaskID"]) {
    const taskId = directGuid(record[key]);
    if (taskId) return taskId;
  }
  if ("Result" in record) {
    const taskId = taskIdFromResult(record.Result);
    if (taskId) return taskId;
  }

  const looksLikeTask = ["State", "StartTime", "EndTime", "Origin"].some((key) => key in record);
  return looksLikeTask ? directGuid(record.Id ?? record.ID) : null;
}

function controllerTaskFinished(task: AmpRecord) {
  return Boolean(task.EndTime) || task.Status === false;
}

async function waitForControllerTask(result: unknown, timeoutMs = defaultWaitTimeoutMs) {
  const taskId = taskIdFromResult(result);
  if (!taskId) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const task = asArray(await ampRequest("Core", "GetTasks"))
      .map(asRecord)
      .find((candidate) => candidate && pickString(candidate, "Id", "ID")?.toLowerCase() === taskId.toLowerCase());
    if (task && controllerTaskFinished(task)) {
      assertAmpAccepted(`task ${taskId}`, task);
      return task;
    }
    await sleep(defaultPollMs);
  }
  throw new Error(`Timed out waiting for AMP task ${taskId} after ${timeoutMs}ms.`);
}

async function resolveTargetAdsInstance(targetADSInstance?: string) {
  if (targetADSInstance) return targetADSInstance;
  const targetInfo = await ampRequest("ADSModule", "GetTargetInfo");
  const targetId = findGuid(targetInfo) ?? findGuid(await ampRequest("Core", "GetModuleInfo"));
  if (targetId) return targetId;
  throw new Error("Could not auto-detect TargetADSInstance. Pass targetADSInstance explicitly.");
}

function registerTools(server: McpServer) {
server.registerTool(
  "amp_configure",
  {
    description: "Set the AMP base URL and optional session ID for subsequent calls.",
    annotations: { title: "Configure AMP connection", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: z.object({
      baseUrl: z.string().url().optional(),
      sessionId: z.string().optional(),
      policyEnabled: z.boolean().optional(),
      policyGroup: z.string().optional(),
    }),
  },
  async (args) => {
    const nextBaseUrl = args.baseUrl ? normalizeBaseUrl(args.baseUrl) : baseUrl;
    if (policyLocked && nextBaseUrl !== baseUrl) {
      throw new Error("AMP base URL is locked by the process environment; restart with AMP_POLICY_LOCKED=false to change it at runtime.");
    }
    if (policyLocked && args.policyEnabled !== undefined && args.policyEnabled !== policyEnabled) {
      throw new Error("AMP policy is locked by the process environment; restart with AMP_POLICY_LOCKED=false to change it at runtime.");
    }
    if (policyLocked && args.policyGroup !== undefined && args.policyGroup !== policyGroup) {
      throw new Error("AMP policy group is locked by the process environment; restart with AMP_POLICY_LOCKED=false to change it at runtime.");
    }
    if (nextBaseUrl !== baseUrl || (args.sessionId !== undefined && args.sessionId !== sessionId)) {
      resetConnectionState();
    }
    baseUrl = nextBaseUrl;
    if (args.sessionId !== undefined) sessionId = args.sessionId;
    if (args.policyEnabled !== undefined) policyEnabled = args.policyEnabled;
    if (args.policyGroup) policyGroup = args.policyGroup;
    return textResult({ baseUrl, hasSession: sessionId.length > 0, policyEnabled, policyGroup, policyLocked });
  },
);

server.registerTool(
  "amp_api_spec",
  {
    description: "Return the AMP API spec. Optionally refresh from /API/Core/GetAPISpec, or return the selected instance's own application modules.",
    annotations: { title: "Get AMP API spec", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      refresh: z.boolean().optional(),
      moduleName: z.string().optional(),
      fromManagedInstance: z
        .boolean()
        .optional()
        .describe("Return the selected instance's own API spec (its application modules) instead of the controller's."),
    }),
  },
  async ({ refresh, moduleName, fromManagedInstance }) => {
    if (fromManagedInstance) {
      if (!managedInstance) {
        throw new Error("No instance is selected. Call amp_use_instance first to inspect an instance's own API spec.");
      }
      if (refresh) {
        managedSpecs.delete(instanceIdOf(managedInstance));
      }
      const selected = managedInstance;
      const instanceSpec = (await getManagedSpec(selected)) ?? {};
      return textResult({
        instance: summarizeInstance(selected),
        moduleName: moduleName ?? null,
        module: moduleName ? (instanceSpec[moduleName] ?? null) : undefined,
        availableModules: Object.keys(instanceSpec),
        spec: moduleName ? undefined : instanceSpec,
      });
    }
    if (refresh) {
        await ensureSession("Core", "GetAPISpec");
        cachedSpec = await refreshControllerSpec();
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
    annotations: { title: "Get AMP module info", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({}),
  },
  async () => textResult(await ampRequest("Core", "GetModuleInfo")),
);

server.registerTool(
  "amp_policy_instances",
  {
    description: "List the AMP instances currently allowed by the MCP policy group, with non-secret diagnostics.",
    annotations: { title: "List policy-allowed instances", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({}),
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
      warning: instances.length === 0 ? await explainEmptyPolicyGroup() : undefined,
    });
  },
);

server.registerTool(
  "amp_auth_requirements",
  {
    description: "Call Core/GetAuthenticationRequirements for a username.",
    annotations: { title: "Get auth requirements", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      username: z.string().min(1),
    }),
  },
  async ({ username }) => textResult(await ampRequest("Core", "GetAuthenticationRequirements", { username })),
);

server.registerTool(
  "amp_login",
  {
    description: "Authenticate with Core/Login and store the returned session in memory. The session is redacted from output.",
    annotations: { title: "Log in to AMP", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      username: z.string().min(1),
      password: z.string().min(1),
      token: z.string().optional().describe("Two-factor token/PIN if required."),
      rememberMe: z.boolean().optional(),
    }),
  },
  async ({ username, password, token, rememberMe }) => {
    const result = await loginControllerWithBackoff({
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
    annotations: { title: "Log in from environment", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({}),
  },
  async () => {
    const username = process.env.AMP_USERNAME;
    const password = process.env.AMP_PASSWORD;
    if (!username || !password) {
      throw new Error("Set AMP_USERNAME and AMP_PASSWORD in the MCP environment or .env before using amp_login_from_env.");
    }

    const result = await loginControllerWithBackoff({
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
    description:
      "Forget the stored AMP session ID and every cached spec, selection and login cooldown. Credentials are kept, so the next call simply logs in again. This is the first thing to try when a managed call fails for a reason that does not fit what you just did - \"The requested instance is not available at this time\", \"requires the Session.Exists permission\", \"Unknown AMP method\" for a method that plainly exists, an instance that amp_status will not show, or a login cooldown after a one-off error. AMP fixes a session's visible instances and its API spec at login time, so a session opened before something changed keeps reporting the old world until it is replaced.",
    annotations: { title: "Clear cached AMP session", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: z.object({}),
  },
  async () => {
    resetConnectionState();
    return textResult({ baseUrl, hasSession: false });
  },
);

server.registerTool(
  "amp_connection_status",
  {
    description: "Show non-secret AMP connection configuration and MCP policy state.",
    annotations: { title: "Get connection status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      checkInstances: z.boolean().optional().describe("Also count visible policy-group instances."),
    }),
  },
  async ({ checkInstances }) => {
    const result: AmpRecord = {
      baseUrl,
      hasUsername: Boolean(process.env.AMP_USERNAME),
      hasPassword: Boolean(process.env.AMP_PASSWORD),
      hasToken: Boolean(process.env.AMP_TOKEN),
      hasControllerSession: Boolean(sessionId),
      hasManagedSession: Boolean(managedInstance && managedSessions.has(instanceIdOf(managedInstance))),
      controllerAuthFailures: controllerAuthRetry.failures,
      controllerAuthRetryAfterMs: Math.max(0, controllerAuthRetry.retryAt - Date.now()),
      policyEnabled,
      policyGroup,
      policyLocked,
      protectedInstanceSelectorsConfigured: protectedInstanceSelectors.size,
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
    annotations: { title: "List instances", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      raw: z.boolean().optional().describe("Include raw AMP instance/status payloads."),
    }),
  },
  async ({ raw }) => textResult(await summarizePolicyInstances(raw ?? false)),
);

server.registerTool(
  "amp_status",
  {
    description: "Show status for the selected instance, a named instance, or all policy-allowed instances.",
    annotations: { title: "Get instance status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      all: z.boolean().optional().describe("Show every instance in the policy group."),
      raw: z.boolean().optional().describe("Include raw AMP instance/status payloads when showing all."),
    }),
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
    annotations: { title: "Select instance to manage", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      instance: z.string().min(1).describe("Instance name, friendly name, or ID. Partial names are okay if unique."),
      startIfStopped: z.boolean().optional().describe("Start the instance first if AMP cannot manage it while stopped."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ instance, startIfStopped, waitTimeoutMs }) => {
    const selected = await resolvePolicyInstance(instance, false);
    const ready = await ensureManagedInstance(selected, { startIfStopped: startIfStopped ?? false, waitTimeoutMs });
    return textResult({
      selected: summarizeInstance(ready.instance, null),
      started: ready.started,
      managed: Boolean(managedInstance),
      hasManagedSession: managedSessions.has(instanceIdOf(ready.instance)),
      status: ready.status,
    });
  },
);

server.registerTool(
  "amp_start_instance",
  {
    description: "Start a policy-allowed AMP instance by name/friendly name/ID, or the selected instance.",
    annotations: { title: "Start instance", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      instance: z.string().optional(),
      wait: z.boolean().optional().describe("Wait until AMP reports the instance is running. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
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
    annotations: { title: "Stop instance", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      instance: z.string().optional(),
      wait: z.boolean().optional().describe("Wait until AMP reports the instance is stopped. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ instance, wait, waitTimeoutMs }) => {
    const selected = await resolvePolicyInstance(instance, true);
    const result = await stopPolicyInstance(selected, wait ?? true, waitTimeoutMs);
    managedSessions.delete(instanceIdOf(selected));
    if (managedInstance && sameInstance(selected, managedInstance)) {
      managedInstance = null;
    }
    return textResult({ instance: summarizeInstance(selected), ...result });
  },
);

server.registerTool(
  "amp_restart_instance",
  {
    description: "Restart a policy-allowed AMP instance. If it is stopped, this starts it instead.",
    annotations: { title: "Restart instance", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      instance: z.string().optional(),
      wait: z.boolean().optional().describe("Wait until AMP reports the instance is running. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ instance, wait, waitTimeoutMs }) => {
    const selected = await resolvePolicyInstance(instance, true);
    const before = await statusForInstance(selected);
    let result: unknown;

    if (before.running === false) {
      const started = await startPolicyInstance(selected, wait ?? true, waitTimeoutMs);
      return textResult({ instance: summarizeInstance(selected), restarted: false, startedBecauseStopped: true, ...started });
    }

    if (wait ?? true) {
      const timeoutMs = waitTimeoutMs ?? defaultWaitTimeoutMs;
      const deadline = Date.now() + timeoutMs;
      let stopped: Awaited<ReturnType<typeof stopPolicyInstance>>;
      try {
        stopped = await stopPolicyInstance(selected, true, timeoutMs, deadline);
      } catch (error) {
        let recovery: Awaited<ReturnType<typeof startPolicyInstance>>;
        try {
          recovery = await startPolicyInstance(selected, false, defaultWaitTimeoutMs, undefined, true);
        } catch (recoveryError) {
          throw new Error(
            `Restart timed out during stop and the direct start recovery call was not accepted: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}. Original cause: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw new Error(
          `Restart did not observe a completed stop before the timeout; a direct start was requested. Recovery: ${JSON.stringify(recovery)}. Cause: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      managedSessions.delete(instanceIdOf(selected));
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        let recovery: Awaited<ReturnType<typeof startPolicyInstance>>;
        try {
          recovery = await startPolicyInstance(selected, false, defaultWaitTimeoutMs, undefined, true);
        } catch (recoveryError) {
          throw new Error(
            `Restart timed out after stopping and the direct start recovery call was not accepted: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}.`,
          );
        }
        throw new Error(`Restart timed out after stopping; a direct start was requested. Recovery: ${JSON.stringify(recovery)}.`);
      }
      const started = await startPolicyInstance(selected, true, remainingMs, deadline);
      return textResult({ instance: summarizeInstance(selected), restarted: true, stopped, started, status: started.status });
    }

    result = await callAdsMethod("RestartInstance", { InstanceName: instanceNameOrThrow(selected) });
    managedSessions.delete(instanceIdOf(selected));
    return textResult({ instance: summarizeInstance(selected), restarted: true, result, status: await statusForInstance(selected) });
  },
);

server.registerTool(
  "amp_files_list",
  {
    description: "List files/folders for the selected or named policy-allowed instance.",
    annotations: { title: "List instance files", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().optional().describe("AMP file-manager path. Defaults to the instance root."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: dir, instance, startIfStopped, waitTimeoutMs }) => {
    const normalizedPath = normalizeAmpPath(dir);
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const listing = await listDirectory(selected, normalizedPath);
    return textResult({ instance: summarizeInstance(selected), ...listing });
  },
);

server.registerTool(
  "amp_file_read",
  {
    description: "Read a file from the selected or named policy-allowed instance using AMP's file manager.",
    annotations: { title: "Read instance file", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("AMP file-manager path to read."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Return text as utf8 or raw base64. Defaults to utf8."),
      maxBytes: z.number().int().positive().optional().describe("Maximum bytes to return. Defaults to AMP_MAX_READ_BYTES or 1 MiB."),
      chunkSize: z.number().int().positive().optional().describe("Read chunk size in bytes."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: filePath, instance, encoding, maxBytes, chunkSize, startIfStopped, waitTimeoutMs }) => {
    const normalizedPath = requiredAmpPath(filePath);
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const file = await readFileContent(selected, normalizedPath, maxBytes, chunkSize ?? defaultFileChunkBytes);
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
    annotations: { title: "Write instance file (overwrites)", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("AMP file-manager path to write."),
      content: z.string().describe("File content. Interpreted as UTF-8 unless encoding is base64."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      encoding: z.enum(["utf8", "base64"]).optional(),
      chunkSize: z.number().int().positive().optional(),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: filePath, content, instance, encoding, chunkSize, startIfStopped, waitTimeoutMs }) => {
    const normalizedPath = requiredAmpPath(filePath);
    const buffer = contentBuffer(content, encoding ?? "utf8");
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await writeFileContent(selected, normalizedPath, buffer, chunkSize ?? defaultFileChunkBytes);
    return textResult({ instance: summarizeInstance(selected), ...result });
  },
);

server.registerTool(
  "amp_file_append",
  {
    description: "Append text or base64 data to a file on the selected or named policy-allowed instance.",
    annotations: { title: "Append to instance file", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("AMP file-manager path to append."),
      content: z.string().describe("Content to append. Interpreted as UTF-8 unless encoding is base64."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      encoding: z.enum(["utf8", "base64"]).optional(),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: filePath, content, instance, encoding, startIfStopped, waitTimeoutMs }) => {
    const normalizedPath = requiredAmpPath(filePath);
    const buffer = contentBuffer(content, encoding ?? "utf8");
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await appendFileContent(selected, normalizedPath, buffer);
    return textResult({ instance: summarizeInstance(selected), ...result });
  },
);

server.registerTool(
  "amp_file_rename",
  {
    description: "Rename a file on the selected or named policy-allowed instance.",
    annotations: { title: "Rename instance file", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("Current AMP file-manager path."),
      newPath: z
        .string()
        .min(1)
        .describe("New name for the file, or a path in the same directory. Renaming cannot move a file between directories."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: filePath, newPath, instance, startIfStopped, waitTimeoutMs }) => {
    const from = requiredAmpPath(filePath);
    const target = splitAmpPath(requiredAmpPath(newPath, "newPath"));
    const source = splitAmpPath(from);

    // AMP resolves NewFilename relative to the source file's own directory, so passing a
    // full path double-prefixes it ("dir/dir/new.txt") and the rename fails. Send the bare
    // name, and reject a different directory rather than silently renaming in place.
    if (target.dir !== "" && target.dir !== source.dir) {
      throw new Error(
        `Cannot rename "${from}" to "${normalizeAmpPath(newPath)}": AMP's RenameFile only renames within a directory and cannot move files. Copy to the new directory with amp_file_copy, then trash the original.`,
      );
    }

    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "RenameFile", {
      Filename: from,
      NewFilename: target.name,
    });
    const renamedTo = source.dir ? `${source.dir}/${target.name}` : target.name;
    return textResult({ instance: summarizeInstance(selected), path: from, newPath: renamedTo, result });
  },
);

server.registerTool(
  "amp_file_copy",
  {
    description: "Copy a file into another directory on the selected or named policy-allowed instance.",
    annotations: { title: "Copy instance file", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("Source AMP file-manager path."),
      targetDirectory: z.string().min(1).describe("Destination directory path."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: filePath, targetDirectory, instance, startIfStopped, waitTimeoutMs }) => {
    const source = requiredAmpPath(filePath);
    const destination = normalizeAmpPath(targetDirectory);
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "CopyFile", {
      Origin: source,
      TargetDirectory: destination,
    });
    return textResult({ instance: summarizeInstance(selected), path: source, targetDirectory: destination, result });
  },
);

server.registerTool(
  "amp_file_trash",
  {
    description: "Move a file to AMP trash on the selected or named policy-allowed instance.",
    annotations: { title: "Move instance file to trash", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("AMP file-manager path to trash."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: filePath, instance, startIfStopped, waitTimeoutMs }) => {
    const normalizedPath = requiredAmpPath(filePath);
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "TrashFile", { Filename: normalizedPath });
    return textResult({ instance: summarizeInstance(selected), path: normalizedPath, trashed: true, result });
  },
);

server.registerTool(
  "amp_directory_create",
  {
    description: "Create a directory on the selected or named policy-allowed instance.",
    annotations: { title: "Create instance directory", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("AMP file-manager directory path to create."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: dirPath, instance, startIfStopped, waitTimeoutMs }) => {
    const normalizedPath = requiredAmpPath(dirPath);
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "CreateDirectory", { NewPath: normalizedPath });
    return textResult({ instance: summarizeInstance(selected), path: normalizedPath, result });
  },
);

server.registerTool(
  "amp_directory_rename",
  {
    description: "Rename a directory on the selected or named policy-allowed instance.",
    annotations: { title: "Rename instance directory", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("Current AMP file-manager directory path."),
      newName: z.string().min(1).describe("New directory name only, not a full path."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: dirPath, newName, instance, startIfStopped, waitTimeoutMs }) => {
    const normalizedPath = requiredAmpPath(dirPath);
    const normalizedName = requiredAmpPath(newName, "newName");
    if (normalizedName.includes("/")) throw new Error("newName must be a directory name, not a path.");
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "RenameDirectory", {
      oldDirectory: normalizedPath,
      NewDirectoryName: normalizedName,
    });
    return textResult({ instance: summarizeInstance(selected), path: normalizedPath, newName: normalizedName, result });
  },
);

server.registerTool(
  "amp_directory_trash",
  {
    description: "Move a directory to AMP trash on the selected or named policy-allowed instance.",
    annotations: { title: "Move directory to trash", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      path: z.string().min(1).describe("AMP file-manager directory path to trash."),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async ({ path: dirPath, instance, startIfStopped, waitTimeoutMs }) => {
    const normalizedPath = requiredAmpPath(dirPath);
    const selected = await managedInstanceFor(instance, startIfStopped ?? true, waitTimeoutMs);
    const result = await callManagedMethod(selected, "FileManagerPlugin", "TrashDirectory", { DirectoryName: normalizedPath });
    return textResult({ instance: summarizeInstance(selected), path: normalizedPath, trashed: true, result });
  },
);

server.registerTool(
  "amp_console_read",
  {
    description: "Read recent console/status updates from the selected or named policy-allowed instance.",
    annotations: { title: "Read instance console", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
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
    annotations: { title: "Send console command", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      message: z.string().min(1),
      instance: z.string().optional().describe("Instance name, friendly name, or ID. Omit to use the selected instance."),
      startIfStopped: z.boolean().optional().describe("Start the instance if needed. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
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
    description: "List AMP-supported applications and configuration IDs that can be used when creating instances.",
    annotations: { title: "List supported applications", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      full: z.boolean().optional().describe("Return full application records instead of summaries."),
    }),
  },
  async ({ full }) => {
    const method = full ? "GetSupportedApplications" : "GetSupportedAppSummaries";
    return textResult(await ampRequest("ADSModule", method));
  },
);

server.registerTool(
  "amp_create_instance",
  {
    description: `Create a new AMP instance in the configured policy group (${policyGroup}). Auto-configured by default; leave autoConfigure alone unless you have read its description, because autoConfigure:false produces an instance this MCP can never manage. To place the instance on specific ports, create it auto-configured and then move the ports with ADSModule/SetInstanceNetworkInfo (see amp_call). The new instance is invisible to other tools until the AMP session is refreshed; this tool does that for you, then waits for the instance and applies the friendly name, because AMP discards it during provisioning. Treat creation as "make the instance exist" only: application settings (world name, MOTD, passwords, slots) do not exist as config nodes until the app is installed, so install with Core/UpdateApplication first, then set them with Core/SetConfig once the instance is running. Check the postCreateConfig field in the result to see what was applied.`,
    annotations: { title: "Create new instance", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      module: z.string().min(1).describe("AMP module name, for example Minecraft, Valheim, or any module reported by amp_supported_apps."),
      applicationId: z.string().optional().describe("Application/configuration ID from amp_supported_apps. Its module and settings are loaded automatically."),
      friendlyName: z.string().min(1).describe("Human-friendly display name for the new instance."),
      instanceName: z.string().optional().describe("Internal instance name. Defaults to a safe name generated from friendlyName."),
      targetADSInstance: z.string().optional().describe("Target ADS instance GUID. Auto-detected when possible."),
      newInstanceId: z.string().optional().describe("New instance GUID. Generated when omitted."),
      autoConfigure: z
        .boolean()
        .optional()
        .describe(
          "Let AMP choose ports/settings. Defaults to true, and should stay true. AMP creates an autoConfigure:false instance in standalone management mode (ManagementMode 0) with its own local admin account, so the controller credentials this MCP holds cannot log into it: every managed call fails with \"Core/Login returned no session ID\" and the instance can never be driven through this MCP. ADSModule/ReactivateInstance does not repair it. Setting specific ports is NOT a reason to pass false - create auto-configured, then move the ports with ADSModule/SetInstanceNetworkInfo. Pass false only to deliberately create a hands-off instance you will manage from the AMP web UI.",
        ),
      ipBinding: z.string().optional().describe("Used when autoConfigure is false. Defaults to 0.0.0.0."),
      portNumber: z.number().int().nonnegative().optional().describe("Used when autoConfigure is false."),
      adminUsername: z.string().optional().describe("Module admin username if the app requires one. Defaults to admin."),
      adminPassword: z.string().optional().describe("Module admin password if the app requires one. Generated when omitted."),
      provisionSettings: z.record(z.string(), z.string()).optional(),
      postCreate: z.union([z.enum(["DoNothing", "UpdateOnce", "UpdateAlways", "UpdateAndStartOnce", "UpdateAndStartAlways", "StartAlways"]), z.number().int()]).optional(),
      startOnBoot: z.boolean().optional(),
      displayImageSource: z.string().optional(),
      targetDatastore: z.number().int().optional(),
      wait: z.boolean().optional().describe("Wait for AMP's create task to finish. Defaults to true."),
      waitTimeoutMs: z.number().int().positive().optional(),
    }),
  },
  async (args) => {
    const autoConfigure = args.autoConfigure ?? true;
    if (!autoConfigure && args.portNumber === undefined) {
      throw new Error("portNumber is required when autoConfigure is false.");
    }

    let moduleName = args.module;
    let provisionSettings = args.provisionSettings ?? {};
    if (args.applicationId) {
      const application = asArray(await ampRequest("ADSModule", "GetSupportedApplications"))
        .map(asRecord)
        .find((candidate) => pickString(candidate, "Id", "ID")?.toLowerCase() === args.applicationId?.toLowerCase());
      if (!application) throw new Error(`Unknown AMP applicationId "${args.applicationId}".`);
      moduleName = pickString(application, "ModuleName") ?? moduleName;
      const settings = asRecord(application.Settings);
      provisionSettings = {
        ...Object.fromEntries(Object.entries(settings ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        ...provisionSettings,
      };
    }

    const safeName =
      args.instanceName ??
      `${args.friendlyName.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 40) || "AMPInstance"}${randomUUID().slice(0, 8)}`;
    const targetADSInstance = await resolveTargetAdsInstance(args.targetADSInstance);
    const body = cleanParams({
      TargetADSInstance: targetADSInstance,
      NewInstanceId: args.newInstanceId ?? randomUUID(),
      Module: moduleName,
      InstanceName: safeName,
      FriendlyName: args.friendlyName,
      IPBinding: args.ipBinding ?? "0.0.0.0",
      PortNumber: args.portNumber ?? 0,
      AdminUsername: args.adminUsername ?? "admin",
      AdminPassword: args.adminPassword ?? randomUUID(),
      ProvisionSettings: provisionSettings,
      AutoConfigure: autoConfigure,
      PostCreate: normalizePostCreate(args.postCreate),
      StartOnBoot: args.startOnBoot ?? false,
      DisplayImageSource: args.displayImageSource,
      TargetDatastore: args.targetDatastore,
      Group: policyGroup,
    });

    const newInstanceId = String(body.NewInstanceId);
    const result = await callAdsMethod("CreateInstance", body);

    // AMP decides which instances a session may see when that session logs in, so
    // the session that just created this instance still cannot see it. Drop the
    // session (keeping the credentials) so the next call re-logs in and finds it.
    // This runs in a finally because AMP's create task routinely outlives the wait
    // timeout: the instance exists either way, and skipping the refresh on the slow
    // path would leave it invisible in exactly the case that needs the refresh most.
    // Creating an instance is not a reason to lose the caller's current selection,
    // so put it back; its managed session is re-established on the next call.
    // AMP accepted the create before the wait began, so a wait timeout means "still
    // provisioning", not "failed". Reporting it as an error sends callers hunting for
    // a problem that does not exist, or worse, creating the instance a second time.
    let task: unknown = null;
    let taskTimedOut = "";
    try {
      if (args.wait ?? true) task = await waitForControllerTask(result, args.waitTimeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/^Timed out waiting for AMP task/.test(message)) throw error;
      taskTimedOut = message;
    } finally {
      const selectedBefore = managedInstance;
      resetConnectionState();
      managedInstance = selectedBefore;
    }

    // Only after the refreshed session can see the instance is it worth configuring.
    const postCreateConfig =
      args.wait ?? true
        ? await applyPostCreateConfig(
            newInstanceId,
            {
              friendlyName: args.friendlyName,
              displayImageSource: args.displayImageSource,
            },
            postCreateConfigTimeoutMs,
          )
        : { status: "skipped", detail: "wait was false, so the instance was not waited for or configured." };

    return textResult({
      policyGroup,
      instanceName: safeName,
      friendlyName: args.friendlyName,
      module: moduleName,
      applicationId: args.applicationId ?? null,
      targetADSInstance,
      autoConfigure,
      result,
      task,
      postCreateConfig,
      note: `The MCP policy forces this instance into display group "${policyGroup}". The AMP session was refreshed so this instance is visible to the other tools.`,
      ...(taskTimedOut
        ? {
            taskTimedOut:
              `${taskTimedOut} AMP accepted the create before this wait started, so the instance almost certainly exists and is still provisioning. Do NOT create it again. Check with amp_instances, and raise waitTimeoutMs if you want this tool to wait longer.`,
          }
        : {}),
      ...(autoConfigure
        ? {}
        : {
            warning:
              "Created with autoConfigure:false, so AMP made this a standalone (ManagementMode 0) instance with its own local admin account. This MCP cannot log into it and cannot manage it. Delete it from the AMP web UI and re-create with autoConfigure:true if that was not intended.",
          }),
    });
  },
);

server.registerTool(
  "amp_call",
  {
    description:
      "Call any method from the AMP API spec. Scope can explicitly target the controller or selected managed instance; auto routes non-ADS modules to the selected instance when present.",
    annotations: { title: "Call any AMP API method", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      moduleName: z.string().min(1),
      methodName: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
      scope: z.enum(["auto", "controller", "managed"]).optional().describe("Defaults to auto."),
      confirm: z.boolean().optional().describe("Required for state-changing methods."),
    }),
  },
  async ({ moduleName, methodName, params, scope, confirm }) => {
    const requestedScope = scope ?? "auto";
    if (requestedScope === "managed" && !managedInstance) {
      throw new Error("No instance is selected. Call amp_use_instance before using managed scope.");
    }
    if (requestedScope === "managed" && moduleName === "ADSModule") {
      throw new Error("ADSModule is controller-scoped; use controller or auto scope.");
    }
    const routeInstance =
      requestedScope === "managed" || (requestedScope === "auto" && managedInstance && moduleName !== "ADSModule")
        ? managedInstance
        : null;
    const { meta, refreshed, refreshError } = await resolveMethodMeta(moduleName, methodName, routeInstance);
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
    const policyBody = await assertPolicyAllows(moduleName, methodName, body, routeInstance);
    const result = await ampRequest(moduleName, methodName, policyBody, routeInstance);
    await updateManagedInstance(moduleName, methodName, policyBody, result);
    assertAmpAccepted(`${moduleName}/${methodName}`, result);
    assertSetterApplied(moduleName, methodName, result);
    return textResult(result);
  },
);
}

// serveStdio may request a fresh protocol server during version fallback. AMP connection
// state is intentionally process-scoped because this executable serves one stdio client.
// A future multi-client HTTP entry point must create the AMP state per MCP session too.
function createStdioServer() {
  const server = new McpServer({ name: "amp-http-mcp-server", version: "1.0.0" });
  registerTools(server);
  return server;
}

// AMP returns an empty listing for a "." root instead of an error, so a regression here
// is silent. Assert the root forms all collapse to "".
function checkPathHandling() {
  const cases: Array<[string | undefined, string]> = [
    [undefined, ""],
    ["", ""],
    ["/", ""],
    [".", ""],
    ["./cfg/server.cfg", "cfg/server.cfg"],
    ["  ", ""],
    ["/cfg/server.cfg", "cfg/server.cfg"],
    ["cfg\\server.cfg", "cfg/server.cfg"],
  ];
  for (const [input, expected] of cases) {
    const actual = normalizeAmpPath(input);
    if (actual !== expected) {
      throw new Error(`normalizeAmpPath(${JSON.stringify(input)}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  }
  try {
    normalizeAmpPath("../outside.txt");
    throw new Error("normalizeAmpPath accepted a parent-directory traversal.");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("cannot contain")) throw error;
  }
  if (!requiresConfirmation("Core", "GetRemoteLoginToken") || requiresConfirmation("Core", "GetStatus")) {
    throw new Error("Sensitive Get* confirmation classification regressed.");
  }
  if (coerceValue({ Name: "value", TypeName: "Nullable<Guid>", Optional: false }, null) !== null) {
    throw new Error("Nullable AMP parameter coercion regressed.");
  }
  try {
    contentBuffer("%%%", "base64");
    throw new Error("Malformed base64 was accepted.");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("valid base64")) throw error;
  }
  const root = splitAmpPath("server.properties");
  if (root.dir !== "" || root.name !== "server.properties") {
    throw new Error(`splitAmpPath("server.properties") returned ${JSON.stringify(root)}; root-level files must use dir "".`);
  }
  const nested = splitAmpPath("/cfg/server.cfg");
  if (nested.dir !== "cfg" || nested.name !== "server.cfg") {
    throw new Error(`splitAmpPath("/cfg/server.cfg") returned ${JSON.stringify(nested)}.`);
  }
}

function checkAuthBackoffAndTaskIds() {
  const retry: AuthRetryState = { failures: 0, retryAt: 0 };
  const before = Date.now();
  recordAuthRejection(retry);
  const after = Date.now();
  if (retry.failures !== 1 || retry.retryAt < before + authRetryBaseMs || retry.retryAt > after + authRetryBaseMs) {
    throw new Error("Authentication retry cooldown calculation regressed.");
  }
  try {
    assertAuthRetryAllowed("Test", retry);
    throw new Error("Authentication retry cooldown allowed an immediate retry.");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("cooling down")) throw error;
  }
  clearAuthRetry(retry);
  if (Number(retry.failures) !== 0 || retry.retryAt !== 0) throw new Error("Authentication retry cooldown reset regressed.");

  const unrelated = "11111111-1111-4111-8111-111111111111";
  const expectedTask = "22222222-2222-4222-8222-222222222222";
  if (taskIdFromResult({ Id: unrelated, InstanceID: unrelated, Result: expectedTask }) !== expectedTask) {
    throw new Error("Controller task extraction selected an unrelated GUID.");
  }
  if (!controllerTaskFinished({ EndTime: "2026-01-01T00:00:00Z", Status: true })) {
    throw new Error("Controller task completion detection regressed.");
  }
}

async function checkPolicyGuards() {
  if (!policyEnabled) return;
  for (const [moduleName, methodName] of [["ADSModule", "StopAllInstances"], ["Core", "DeleteUser"]]) {
    try {
      await assertPolicyAllows(moduleName, methodName, {}, null);
      throw new Error(`Policy accepted unscoped mutation ${moduleName}/${methodName}.`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Policy blocked")) throw error;
    }
  }
}

// The three failure modes below all used to surface as something misleading, so
// assert each one still explains itself.
function checkDiagnosticMessages() {
  const settingDenial = permissionHint(
    "Core/SetConfig",
    "The current user does not have permission to modify setting 'Meta.GenericModule.world'.",
  );
  if (!settingDenial.includes("Meta.GenericModule.world") || !settingDenial.includes("super admin")) {
    throw new Error("Setting-level permission denials no longer name the setting and the fix.");
  }
  if (permissionHint("Core/GetStatus", "The specified instance is not running") !== "") {
    throw new Error("permissionHint fires on errors that are not permission denials.");
  }

  try {
    assertSetterApplied("Core", "SetConfigs", false);
    throw new Error("A bare false from a bulk setter was treated as success.");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Core/SetConfig ")) {
      throw new Error("SetConfigs failure no longer points at the singular SetConfig.");
    }
  }
  assertSetterApplied("Core", "SetConfigs", true);
  assertSetterApplied("Core", "GetConfigs", false);

  if (isAuthenticatedSpec({ Core: { Login: {} } } as unknown as AmpSpec)) {
    throw new Error("The pre-login stub spec is being treated as authenticated and would be cached.");
  }
  if (!isAuthenticatedSpec({ Core: { GetStatus: {} } } as unknown as AmpSpec)) {
    throw new Error("A real authenticated spec is no longer cacheable.");
  }
}

async function selfTest() {
  checkPathHandling();
  checkAuthBackoffAndTaskIds();
  checkDiagnosticMessages();
  await checkPolicyGuards();
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
    const loginResult = await loginAndRefresh({
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
  const handle = serveStdio(createStdioServer);
  console.error(`amp-http-mcp-server connected for ${baseUrl}`);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
