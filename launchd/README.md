# macOS LaunchAgent

The maintained macOS service interface is:

```bash
./scripts/service-macos.sh install
./scripts/service-macos.sh status
./scripts/service-macos.sh logs
./scripts/service-macos.sh restart
./scripts/service-macos.sh uninstall
```

It installs separate per-user LaunchAgents for the MCP server and `tunnel-client`. See [Operations](../docs/OPERATIONS.md) and the main README.
