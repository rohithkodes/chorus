# Chorus

Real-time multi-client log viewer and debugging dashboard.

Chorus helps you visualize and debug logs from multiple application instances simultaneously. It receives log entries over UDP and displays them in a synchronized, color-coded grid view.

## Features

- **Multi-client view** - See logs from multiple app instances side-by-side
- **Time-aligned rows** - Related events snap together for easy correlation
- **Log filtering** - Filter by log level (log, warning, error, network)
- **Search** - Find specific messages with Ctrl+F
- **Session management** - Save and load debugging sessions
- **Browser log import** - Import Chrome DevTools log exports

## Installation

### Download (Recommended)
Download the latest release from the [Releases page](https://github.com/rohithkodes/chorus/releases).

### From Source

```bash
# Clone the repository
git clone https://github.com/rohithkodes/chorus.git
cd chorus

# Install dependencies
npm install

# Run the app
npm start
```

### Build Executable

```bash
npm run build
```

The executable will be created in the `dist` folder.

## Connecting Your Application

Chorus listens for JSON log entries on **UDP port 9901**. Any application that can send UDP packets can integrate with Chorus.

### Log Entry Format

Send JSON objects with the following structure:

```json
{
  "clientId": "Player1",
  "timestamp": 1234567890123,
  "eventType": "log",
  "message": "Player connected to server"
}
```

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| `clientId` | string | Unique identifier for the client/instance |
| `timestamp` | number | Unix timestamp in milliseconds |
| `eventType` | string | One of: `log`, `warning`, `error`, `network` |
| `message` | string | The log message content |

#### Event Types

- `log` - General information (white)
- `warning` - Warnings (yellow)
- `error` - Errors and exceptions (red)
- `network` - Network/tagged events (purple)

### Tagged Messages

Messages prefixed with `[PS:TAG]` are automatically styled with tag colors:

```
[PS:NETWORK] Connected to server
[PS:STATE] Game state changed to Playing
[PS:INIT] Initialization complete
```

Available tags: `NETWORK`, `STATE`, `INIT`, `RECONNECT`

### Client Renaming

To rename a client dynamically (e.g., after authentication):

```json
{
  "clientId": "Player1",
  "eventType": "rename",
  "newClientId": "JohnDoe"
}
```

## Integration Examples

### Unity (C#)

```csharp
using System.Net;
using System.Net.Sockets;
using System.Text;
using UnityEngine;

public class ChorusLogger : MonoBehaviour
{
    private UdpClient udpClient;
    private IPEndPoint endPoint;
    private string clientId;

    void Awake()
    {
        udpClient = new UdpClient();
        endPoint = new IPEndPoint(IPAddress.Loopback, 9901);
        clientId = "Client_" + Random.Range(1000, 9999);
    }

    public void Log(string message, string eventType = "log")
    {
        var entry = new {
            clientId = this.clientId,
            timestamp = System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            eventType = eventType,
            message = message
        };

        string json = JsonUtility.ToJson(entry);
        byte[] data = Encoding.UTF8.GetBytes(json);
        udpClient.Send(data, data.Length, endPoint);
    }

    public void LogWarning(string message) => Log(message, "warning");
    public void LogError(string message) => Log(message, "error");
    public void LogNetwork(string message) => Log(message, "network");

    void OnDestroy()
    {
        udpClient?.Close();
    }
}
```

### Node.js

```javascript
const dgram = require('dgram');
const client = dgram.createSocket('udp4');

function log(message, eventType = 'log') {
  const entry = {
    clientId: process.env.CLIENT_ID || 'NodeApp',
    timestamp: Date.now(),
    eventType,
    message
  };

  const data = Buffer.from(JSON.stringify(entry));
  client.send(data, 9901, 'localhost');
}

// Usage
log('Application started');
log('Connection failed', 'error');
log('[PS:NETWORK] Socket connected', 'network');
```

### Python

```python
import socket
import json
import time

class ChorusLogger:
    def __init__(self, client_id="PythonApp", host="127.0.0.1", port=9901):
        self.client_id = client_id
        self.address = (host, port)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def log(self, message, event_type="log"):
        entry = {
            "clientId": self.client_id,
            "timestamp": int(time.time() * 1000),
            "eventType": event_type,
            "message": message
        }
        self.sock.sendto(json.dumps(entry).encode(), self.address)

    def warning(self, message):
        self.log(message, "warning")

    def error(self, message):
        self.log(message, "error")

# Usage
logger = ChorusLogger("Worker1")
logger.log("Processing started")
logger.warning("Memory usage high")
logger.error("Connection timeout")
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+F` | Open search |
| `Enter` | Next search result |
| `Shift+Enter` | Previous search result |
| `Escape` | Close search |

## Snap Window

The "snap" feature aligns related log entries from different clients into the same row. Adjust the snap window (in milliseconds) to control how close timestamps need to be for alignment.

## License

MIT
