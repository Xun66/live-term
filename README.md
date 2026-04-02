# live-term

**live-term** is a secure, End-to-End Encrypted (E2EE) terminal synchronization tool. It allows you to share your terminal session with a remote controller through a relay server.

## Quick Start

### 1. Install via NPM

```bash
npm install -g @xun66/live-term
```

---

### 🌍 Case 1: Using the Free Relay Server (Easiest)

We provide a free public relay server at `xebox.org`.

**Target (The machine you want to control):**
```bash
TERMINAL_SERVER_URL=wss://xebox.org/live-term/ live-term
```
*Wait for the `Session ID` to be printed, then share it with the controller.*

**Controller (The machine you are controlling from):**
```bash
TERMINAL_SERVER_URL=wss://xebox.org/live-term/ live-term --mode=controller --target-uuid=YOUR_ID
```

---

### 🏠 Case 2: Using your own Local/Private Server

If you are running the relay server yourself:

**Target:**
```bash
live-term --server=ws://localhost:8899/live-term/ --allow-insecure
```

**Controller:**
```bash
live-term --server=ws://localhost:8899/live-term/ --allow-insecure --mode=controller --target-uuid=YOUR_ID
```

---

## CLI Options

| Argument | Description | Default |
| :--- | :--- | :--- |
| `--mode` | Run mode: `target` or `controller`. | `target` |
| `--id` | (Target only) Custom session ID. | (Random 6 chars) |
| `--target-uuid`| (Controller only) ID of the target to connect to. | **Required** |
| `--server` | Full URL of the relay server. | `ws://127.0.0.1:8899/live-term/` |
| `--allow-insecure` | Allow `ws://` or self-signed certificates. | `false` |
| `--hotkey` | Key to exit target mode. | `\x18` (Ctrl+X) |

## Self-Hosting the Relay

You can run the relay server using Node or Docker:

```bash
# Node
live-term-server --port 8899 --path=/live-term/

# Docker
docker run -p 8899:8899 -e API_BASE=/live-term/ ghcr.io/xun66/live-term-relay:latest
```

## Security

- **E2EE**: All data is encrypted with AES-256-GCM. Keys are exchanged via RSA and never touch the server.
- **SAS Verification**: A 6-digit verification code is shown on both ends to prevent Man-in-the-Middle attacks.
- **Explicit Approval**: The target must manually approve any incoming connection.

## License

MIT
