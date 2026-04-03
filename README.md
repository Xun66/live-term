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
*It will print a `Session ID` (e.g., `a1b2c3`). Share this with the controller.*

**Controller (The machine you are controlling from):**
```bash
TERMINAL_SERVER_URL=wss://xebox.org/live-term/ live-term --mode=controller --target-id=YOUR_ID
```

---

### 🏠 Case 2: Using your own Local/Private Server

**Target:**
```bash
live-term --server=ws://localhost:8899/live-term/ --allow-insecure
```

**Controller:**
```bash
live-term --server=ws://localhost:8899/live-term/ --allow-insecure --mode=controller --target-id=YOUR_ID
```

---

## CLI Options

| Argument | Description | Default |
| :--- | :--- | :--- |
| `--mode` | Run mode: `target` or `controller`. | `target` |
| `--target-id`| (Controller only) The Session ID of the target. | **Required** |
| `--id` | (Target only) Custom Session ID (Vanity ID). | (Random 6 chars) |
| `--server` | Full URL of the relay server. | `ws://127.0.0.1:8899/live-term/` |
| `--allow-insecure` | Allow `ws://` or self-signed certificates. | `false` |
| `--hotkey` | Key to exit session (e.g., `ctrl+b`, `^x`). | `ctrl+x` |

### Hotkey Examples:
- `--hotkey=ctrl+b`
- `--hotkey=^q`
- `--hotkey=f1` (literal characters)

## Security

- **E2EE**: All data is encrypted with AES-256-GCM. Keys are exchanged via RSA and never touch the server.
- **Verification Code (SAS)**: A **6-digit numeric code** is shown on both ends. **Verify this matches** to ensure no Man-in-the-Middle is present.
- **Explicit Approval**: The target must manually approve any incoming connection.

## Self-Hosting the Relay

```bash
# Node
live-term-server --port 8899 --path=/live-term/

# Docker
docker run -p 8899:8899 -e API_BASE=/live-term/ ghcr.io/xun66/live-term-relay:latest
```

## License

MIT
