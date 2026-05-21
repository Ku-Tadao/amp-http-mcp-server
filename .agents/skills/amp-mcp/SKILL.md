---
name: amp-mcp
description: "Use when Codex needs to operate, diagnose, or safely automate CubeCoders AMP through the AMP MCP server: checking AMP MCP connection/env/policy status, listing/selecting/starting/stopping/creating AMP instances, using AMP File Manager or console tools, reading server files/configs/plugins through AMP, or troubleshooting empty policy groups and raw AMP API calls. Do not use for unrelated local-only code review unless the task involves AMP-managed server files."
---

# AMP MCP

Use the friendly AMP MCP tools first. Treat `amp_call` as an escape hatch for advanced AMP API methods.

## First Checks

1. Call `amp_connection_status` with `checkInstances: true` when available.
2. If that tool is unavailable, call `amp_policy_instances`.
3. Confirm `policyEnabled`, `policyGroup`, credential presence flags, and visible instance count before concluding AMP has no accessible instances.
4. Do not assume a missing repo-local `.env` means the MCP is unconfigured. Codex may inject `AMP_BASE_URL`, `AMP_USERNAME`, `AMP_PASSWORD`, `AMP_TOKEN`, and policy settings from `~/.codex/config.toml` or another MCP client environment.

If the policy group is empty, read `references/troubleshooting.md` before diagnosing.

## Tool Use

Prefer these high-level tools:

- `amp_instances`: list allowed instances.
- `amp_status`: inspect one instance or all instances.
- `amp_use_instance`: select an instance by unique name, friendly name, or ID.
- `amp_start_instance`, `amp_stop_instance`, `amp_restart_instance`: manage lifecycle.
- `amp_files_list`, `amp_file_read`, `amp_file_write`, `amp_file_append`, `amp_file_rename`, `amp_file_copy`, `amp_file_trash`: operate through AMP File Manager.
- `amp_directory_create`, `amp_directory_rename`, `amp_directory_trash`: manage directories.
- `amp_console_read`, `amp_console_send`: inspect/send console input.
- `amp_supported_apps`, `amp_create_instance`: inspect app modules and create new policy-group instances.

Use `amp_api_spec` directly as an MCP tool to inspect AMP modules and methods. Never pass `amp_api_spec` as `moduleName` to `amp_call`; it is not an AMP API module.

Use `amp_call` only when no friendly tool covers the operation. For raw calls, use AMP module/method names such as:

```json
{
  "moduleName": "ADSModule",
  "methodName": "GetInstances",
  "params": { "ForceIncludeSelf": true }
}
```

## Safety

- Keep all operations inside the configured MCP policy group.
- Do not print passwords, tokens, session IDs, or admin credentials.
- If you start a stopped instance only to inspect files, restore it to stopped before finishing unless the user asked otherwise.
- Prefer read-only inspection before write/delete/trash operations.
- For destructive or broad raw `amp_call` methods, require the MCP's `confirm: true` behavior and explain the target.

## File And Plugin Review

When reviewing files inside an AMP-managed server:

1. Select the target instance with `amp_use_instance`.
2. List candidate folders with `amp_files_list`.
3. Read relevant files with `amp_file_read`.
4. Compare against any docs the user provided or local workspace docs.
5. Report only findings grounded in file paths, plugin names, and exact behavior.

Do not assume the target is Rust, Minecraft, or any other module unless the user says so or the AMP instance metadata shows it. For Oxide Rust review specifically, read the user's `OxideRustDocumentation.txt` if present, then inspect the instance's Oxide plugin directory through AMP.

## Reporting

When blocked, include the exact MCP checks used and the non-secret facts returned: tool availability, `baseUrl`, credential presence flags, `policyGroup`, visible instance count, selected instance, and the AMP error message. Avoid vague conclusions like "AMP has no instances" unless credential/env and policy diagnostics support it.
