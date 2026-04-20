# live-term

[中文](./README_CN.md)

**live-term** is a secure, End-to-End Encrypted (E2EE) terminal collaboration tool. It allows you to share your terminal session with a remote collaborator through a relay, and every remote-control session must be explicitly approved on the target side.

https://github.com/user-attachments/assets/02a94823-0e09-470a-a55e-4ba3ff4b7fa4

> Note: The relay URL shown in the video is for demonstration only. For actual usage, follow the commands below.


## Quick Start

### 1. Install via NPM

```bash
npm install -g @xun66/live-term
```

---

### 🌍 Case 1: Using the Free Relay (Easiest)

We provide a free public relay at `xebox.org`.

**Target (The machine you want to control):**
```bash
TERMINAL_RELAY_URL=wss://xebox.org/live-term/ws live-term
```
*It will print a `Session ID` (UUID). Share this with the controller.*

**Controller (The machine you are controlling from):**
```bash
TERMINAL_RELAY_URL=wss://xebox.org/live-term/ws live-term --mode=controller --target-id=Session_ID
```

---

### 🏠 Case 2: Using your own Local/Private Relay

**Target:**
```bash
TERMINAL_RELAY_URL=ws://localhost:8899/live-term/ws live-term --allow-insecure
```

**Controller:**
```bash
TERMINAL_RELAY_URL=ws://localhost:8899/live-term/ws live-term --mode=controller --target-id=Session_ID --allow-insecure
```

---

## Configuration Options

| Argument | Description | Default |
| :--- | :--- | :--- |
| `--mode` | Run mode: `target` or `controller`. | `target` |
| `--target-id`| (Controller only) The Session ID of the target. | **Required** |
| `--id` | (Target only) Custom Session ID (Vanity ID). | (Random 6 chars) |
| `--relay` | Full URL of the relay. | `ws://127.0.0.1:8899/live-term/ws` |
| `--allow-insecure` | Allow `ws://` or self-signed certificates. | `false` |
| `--hotkey` | Key to exit session (e.g., `ctrl+b`, `^x`). | `ctrl+x` |

> **Note:** You can use the `TERMINAL_RELAY_URL` environment variable (as shown in the examples) or the `--relay` flag to specify the relay.

## Security

- **E2EE**: All data is encrypted with AES-256-GCM. Keys are exchanged via RSA and never touch the relay.
- **Verification Code (SAS)**: A **6-digit numeric code** is shown on both ends. **Verify this matches** to ensure no Man-in-the-Middle is present.
- **Explicit Approval**: The target must manually approve every incoming remote-control request.

## Self-Hosting the Relay

```bash
# Node (single path)
live-term-relay --port 8899 --paths=/live-term/ws

# Docker
docker run -p 8899:8899 -e WS_PATHS=/live-term/ws ghcr.io/xun66/live-term-relay:latest
```

## License

MIT

## Links

- [linux.do](https://linux.do)
