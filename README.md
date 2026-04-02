# TermChat

**TermChat** is a terminal bidirectional End-to-End Encrypted (E2EE) remote sync tool. It allows two terminal instances (a "target" and a "controller") to securely communicate through a relay server.

## Features

- **E2EE Security**: All terminal data is encrypted using AES-256-GCM before leaving the client.
- **Bidirectional Sync**: Real-time synchronization of terminal input and output.
- **Relay Server**: Simple Node.js relay server for session handling.
- **Docker Support**: Easy deployment of the relay server using Docker.

## Project Note

This project was developed with significant assistance from **AI (Gemini CLI)**. The AI assisted in architecting the E2EE envelope, implementing the relay logic, and refining the Docker configuration.

## Getting Started

### 1. Start the Relay Server

You can run the relay server locally or using Docker.

**Locally:**
```bash
node server/index.js --port 8899
```

**Docker:**
```bash
docker build -t termchat-relay .
docker run -p 8899:8899 termchat-relay
```

### 2. Connect as Target

On the machine you want to control:
```bash
node client/main.js --mode=target --id=YOUR_SESSION_ID
```

### 3. Connect as Controller

On the machine you are controlling from:
```bash
node client/main.js --mode=controller --id=YOUR_SESSION_ID
```

## Security

TermChat enforces secure connections by default. If you need to use an insecure `ws://` connection (e.g., for local testing), you must pass the `--allow-insecure` flag.

## License

MIT License. See [LICENSE](LICENSE) for details.
