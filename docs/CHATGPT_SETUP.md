# Set up ChatGPT website and desktop app

The bridge has one local runtime, but OpenAI currently exposes two different ChatGPT integration paths:

- **ChatGPT website:** register the tunnel-backed MCP connection and use it directly in Developer Mode.
- **ChatGPT desktop app (Work mode/Codex):** register the connection on the website first, then either use it if it already appears in the desktop Plugins/Developer Mode picker or package that registered connection as a local plugin.

> The tunnel connection is currently registered on the **website**, not in native desktop settings. UI labels and plan policy can change; the official links at the end are authoritative.

## 1. Start and verify the local runtime

From the repository:

```bash
npm run start:all
```

Keep that process running. It starts the MCP bridge first, waits for it to become ready, and then starts `tunnel-client`.

macOS/Linux readiness checks:

```bash
curl -f http://127.0.0.1:8765/readyz
curl -f http://127.0.0.1:8766/readyz
```

Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/readyz
Invoke-RestMethod http://127.0.0.1:8766/readyz
```

Expected results:

- Bridge readiness returns HTTP 200 with `"toolCount": 44`.
- Tunnel readiness returns HTTP 200 with `ready`.

If the tunnel is not configured yet, run the guided setup first:

```bash
# macOS/Linux
./scripts/connect-chatgpt.sh
```

```powershell
# Windows
.\scripts\windows\configure-tunnel.ps1
```

## 2. Register and use it on the ChatGPT website

### Enable Developer Mode

1. Open <https://chatgpt.com/> in a web browser.
2. Select the correct account/workspace.
3. Open **Settings → Security and login**.
4. Enable **Developer mode**.

If the setting is absent, confirm that your plan/workspace is eligible. Managed Business/Enterprise/Education workspaces may require an admin grant.

### Create the tunnel-backed connection

1. Keep `npm run start:all` running.
2. Open <https://chatgpt.com/plugins>.
3. Select **+** to create a developer-mode app/connection.
4. Enter a recognizable name such as **SOL Local Bridge**.
5. Choose **Connection = Tunnel**.
6. Select or paste the `tunnel_...` ID created in OpenAI Platform.
7. Choose **No Authentication**.
8. Create the connection and verify that discovery returns exactly **44 tools**.

**Do not choose OAuth for this repository's default setup.** The local MCP endpoint intentionally uses no application-level authentication behind the private tunnel. `tunnel-client` authenticates separately to OpenAI using the runtime API key stored in the user-only `runtime.env`; never paste that key into ChatGPT.

### Use it in a website conversation

1. Start a new ChatGPT conversation.
2. Open the composer's **+** menu.
3. Choose **Developer mode** and select **SOL Local Bridge**.
4. Send a read-only first request:

> Use SOL Local Bridge only. Call `bridge_instructions`, then `workspace_list`, then `workspace_snapshot`. Do not modify anything.

Then test a bounded write inside an authorized workspace:

> Use `write_file` to create `hello.txt` in my authorized workspace, read it back, and edit its text. Do not delete anything.

ChatGPT may show its own write confirmation. Destructive bridge operations have an additional exact-preview confirmation gate.

## 3. Use it in the ChatGPT desktop app

### What is and is not configured in the desktop app

The official setup flow still registers a custom MCP connection at <https://chatgpt.com/plugins>. Do that first, even if your goal is desktop use.

After creating the website connection:

1. Sign in to the desktop app with the same account and workspace.
2. Update to the current desktop release and restart it.
3. Check the desktop **Plugins Directory**, **Developer mode**, or composer plugin picker.
4. If **SOL Local Bridge** already appears, install/enable it and use the same test prompts shown above.

Availability varies by desktop build and surface. If the registered app does not appear directly, use the Work mode/Codex plugin packaging route below.

### Package the registered connection for desktop Work mode/Codex

The tunnel ID and plugin connection ID are different:

- `tunnel_...` identifies the Secure MCP Tunnel.
- `plugin_asdk_app_...` identifies the registered ChatGPT MCP connection and is what the desktop plugin references.

1. Open the connection you created at <https://chatgpt.com/plugins>.
2. Copy its technical ID from the browser URL. It starts with `plugin_asdk_app_`.
3. Open **Work mode** in the ChatGPT desktop app.
4. Ask the built-in plugin creator:

> `@plugin-creator create a plugin for ChatGPT and Codex using my MCP server. Use plugin_asdk_app_REPLACE_ME and name it SOL Local Bridge. Include a personal marketplace entry so I can test it locally.`

5. Review the generated files before installing:
   - `.app.json` must map to the correct `plugin_asdk_app_...` ID.
   - `.codex-plugin/plugin.json` must point its compatibility `apps` field to `./.app.json`.
   - The personal marketplace entry should point to the generated plugin folder.
6. Restart the ChatGPT desktop app.
7. Open **Plugins Directory**, select the personal/local marketplace source, and install **SOL Local Bridge**.
8. Enable the plugin in a new Work mode/Codex conversation and send the read-only test prompt.

If the desktop app has no Work mode, Plugins Directory, or `@plugin-creator`, update it. If those surfaces remain unavailable for your account/build, use the ChatGPT website integration; do not expose the local MCP server publicly as a workaround.

## 4. Troubleshooting

### “Error creating connector”

Check readiness before retrying:

```bash
curl -f http://127.0.0.1:8765/readyz
curl -f http://127.0.0.1:8766/readyz
```

Both must return HTTP 200 while the connection is created. Run `npm run start:all` rather than launching the tunnel first; the wrapper prevents an MCP cold-start race.

### Tunnel is missing or rejected

Verify all of the following:

- The tunnel is associated with the target ChatGPT workspace, not only a Platform organization.
- The operator has Tunnels **Read + Use**.
- `tunnel-client` uses the same `tunnel_...` ID.
- The intended account/workspace is selected in ChatGPT.

### Connector exists but shows no tools

1. Keep the bridge and tunnel running.
2. Confirm bridge readiness reports 44 tools.
3. Open the connection details at <https://chatgpt.com/plugins> and refresh its tools.
4. Start a new conversation after refreshing.

### Desktop plugin does not appear

- Confirm the desktop app is signed into the same account/workspace used for registration.
- Confirm `.app.json` uses `plugin_asdk_app_...`, not `tunnel_...`.
- Confirm the plugin is present in a personal or repository marketplace.
- Restart the desktop app after marketplace/plugin changes.
- Open the Plugins Directory and select the correct marketplace source.

## 5. Security reminders

- Start with a dedicated workspace directory rather than your whole home directory.
- Keep `runtime.env` private and never paste its API key into ChatGPT.
- Choose **No Authentication** only because the MCP server is behind Secure MCP Tunnel; do not expose the no-auth endpoint beyond loopback.
- Review tool payloads and write confirmations.
- Workspace roots constrain structured file tools and command working directories, but generic shell, project scripts, browser automation, and Codex are not an OS sandbox.

## Official references

- [ChatGPT Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Package a plugin for ChatGPT and Codex](https://developers.openai.com/plugins/build/plugins)
- [ChatGPT Plugins](https://chatgpt.com/plugins)
