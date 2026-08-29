# S1 platform scope

The reviewed runtime proof targets the pinned `linux/amd64` Node base image.
Docker must report the same architecture before treating the container proof as
evidence for another host.

The upstream platform adapter files remain in the local fork for provenance,
but desktop, browser, input, screen, audio, clipboard, notification,
scheduler, Office, and web capabilities are not registered by the S1 server.
They are also excluded from the runtime image where they are not needed.

An arm64 image, native-host execution, or desktop integration requires a new
review. No persistent service or platform scheduler is installed by S1.
