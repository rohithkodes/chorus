using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using UnityEngine;

/// <summary>
/// Chorus Logger — broadcasts Unity logs over UDP to the Chorus Dashboard.
/// Disabled entirely on WebGL builds. Use Chrome DevTools log export instead.
/// </summary>
public class ChorusLogger : MonoBehaviour
{
#if !UNITY_WEBGL || UNITY_EDITOR

    [Header("Dashboard Connection")]
    [Tooltip("IP of the machine running the Chorus Dashboard. Use 127.0.0.1 for local testing.")]
    public string dashboardIP = "127.0.0.1";

    [Tooltip("Must match the port the Dashboard is listening on.")]
    public int dashboardPort = 9901;

    [Header("Client Identity")]
    [Tooltip("Set at runtime via SetClientId(). Falls back to 'Unknown' if never called.")]
    public string clientId = "Unknown";

    [Header("Network Event Detection")]
    [Tooltip("Log messages containing any of these keywords are classified as 'network' events in Chorus. Add your networking library's callback names here.")]
    public string[] networkEventKeywords = new[]
    {
        // Photon PUN 2 — remove or replace with your networking library's callbacks
        "OnPlayerEnteredRoom", "OnPlayerLeftRoom",
        "OnJoinedRoom", "OnLeftRoom", "OnDisconnected",
        "OnConnectedToMaster", "OnRoomListUpdate",
        "OnMasterClientSwitched", "RPC", "OnEvent"
    };

    private UdpClient _udp;
    private IPEndPoint _endpoint;
    private long _startTimestamp;

    public static ChorusLogger Instance { get; private set; }

    private void Awake()
    {
        Instance = this;
        DontDestroyOnLoad(gameObject);
        _startTimestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        try
        {
            _udp = new UdpClient();
            _endpoint = new IPEndPoint(IPAddress.Parse(dashboardIP), dashboardPort);
            Application.logMessageReceived += OnLog;
            Debug.Log($"[Chorus] Broadcasting as '{clientId}' → {dashboardIP}:{dashboardPort}");
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[Chorus] UDP init failed: {e.Message}");
        }
    }

    private void OnDestroy()
    {
        Application.logMessageReceived -= OnLog;
        _udp?.Close();
    }

    public void SetClientId(string id)
    {
        if (id == clientId) return;
        RenameClient(id);
    }

    public void RenameClient(string newId)
    {
        string oldId = clientId;
        clientId = newId;

        try
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            string json = "{"
                + $"\"clientId\":\"{Escape(oldId)}\","
                + $"\"timestamp\":{now},"
                + $"\"elapsed\":{now - _startTimestamp},"
                + $"\"logType\":\"Log\","
                + $"\"eventType\":\"rename\","
                + $"\"message\":\"Client renamed to {Escape(newId)}\","
                + $"\"newClientId\":\"{Escape(newId)}\""
                + "}";

            byte[] data = Encoding.UTF8.GetBytes(json);
            _udp.Send(data, data.Length, _endpoint);
            Debug.Log($"[Chorus] Renamed '{oldId}' → '{newId}'");
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[Chorus] Failed to send rename event: {e.Message}");
        }
    }

    private void OnLog(string message, string stackTrace, LogType type)
    {
        try
        {
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            long elapsed = now - _startTimestamp;
            string eventType = ClassifyEvent(message, type);

            string json = "{"
                + $"\"clientId\":\"{Escape(clientId)}\","
                + $"\"timestamp\":{now},"
                + $"\"elapsed\":{elapsed},"
                + $"\"logType\":\"{type}\","
                + $"\"eventType\":\"{eventType}\","
                + $"\"message\":\"{Escape(message)}\""
                + "}";

            byte[] data = Encoding.UTF8.GetBytes(json);
            _udp.Send(data, data.Length, _endpoint);
        }
        catch
        {
            // Silently swallow — never crash the game over logging
        }
    }

    private static string ClassifyEvent(string message, LogType type)
    {
        if (type == LogType.Error || type == LogType.Exception) return "error";
        if (type == LogType.Warning) return "warning";

        foreach (var keyword in networkEventKeywords)
            if (message.Contains(keyword, StringComparison.OrdinalIgnoreCase))
                return "network";

        return "log";
    }

    private static string Escape(string s)
    {
        return s.Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r")
                .Replace("\t", "\\t");
    }

#endif // !UNITY_WEBGL || UNITY_EDITOR
}
