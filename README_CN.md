# live-term

[English](./README.md)

**live-term** 是一个安全、端到端加密（E2EE）的终端协作工具。它允许你通过中继（Relay）与远程协作者共享你的终端会话，且被控端每次被控都必须显式批准连接请求。

https://github.com/user-attachments/assets/02a94823-0e09-470a-a55e-4ba3ff4b7fa4

> 注意：视频中的 relay URL 仅供演示，实际调用命令请以下方说明为准。

## 快速开始

### 1. 通过 NPM 安装

```bash
npm install -g @xun66/live-term
```

---

### 🌍 场景 1：使用免费公开中继（最简单）

我们提供了一个免费的公开中继：`xebox.org`。

**被控端（Target，即你想共享终端的机器）：**
```bash
live-term
```
*它会打印一个 `Session ID` (UUID)。将此 ID 分享给控制端。*

**控制端（Controller，即你进行操作的机器）：**
```bash
live-term --mode=controller --target-id=Session_ID
```

---

### 🏠 场景 2：使用你自己的本地/私有中继

**被控端：**
```bash
TERMINAL_RELAY_URL=ws://localhost:8899/live-term/ws live-term --allow-insecure
```

**控制端：**
```bash
TERMINAL_RELAY_URL=ws://localhost:8899/live-term/ws live-term --mode=controller --target-id=Session_ID --allow-insecure
```

---

## 配置选项

| 参数 | 描述 | 默认值 |
| :--- | :--- | :--- |
| `--mode` | 运行模式：`target` 或 `controller`。 | `target` |
| `--target-id`| （仅限控制端）被控端的会话 ID。 | **必填** |
| `--id` | （仅限被控端）自定义会话 ID (Vanity ID)。 | (随机 6 位字符) |
| `--relay` | 中继服务器的完整 URL。 | `wss://xebox.org/live-term/ws` |
| `--allow-insecure` | 允许 `ws://` 或自签名证书。 | `false` |
| `--hotkey` | 退出会话的热键（如 `ctrl+b`, `^x`）。 | `ctrl+x` |

> **注意：** 你可以使用 `TERMINAL_RELAY_URL` 环境变量（如示例所示）或 `--relay` 标志来指定中继服务器。

## 安全性

- **端到端加密 (E2EE)**：所有数据都使用 AES-256-GCM 加密。密钥通过 RSA 交换，绝不会接触到中继服务器。
- **验证码 (SAS)**：两端都会显示一个 **6 位数字代码**。**验证此代码是否一致**以确保没有中间人攻击（MITM）。
- **显式批准**：被控端每次被控都必须手动批准连接。

## 自行托管中继服务器

```bash
# 使用 Node（单路径）
live-term-relay --port 8899 --paths=/live-term/ws

# 使用 Docker
docker run -p 8899:8899 -e WS_PATHS=/live-term/ws ghcr.io/xun66/live-term-relay:latest
```

## 许可证

MIT

## 友情链接

- [linux.do](https://linux.do)
