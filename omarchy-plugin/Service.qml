import QtQuick
import qs.Commons

// Talks to the BeeDocs API and launches the workspace window. All HTTP goes
// through QML's XMLHttpRequest against `baseUrl`; QtWebEngine is not an option
// here (Chromium cannot initialize inside Quickshell), which is why the
// workspace opens as a chromium app-mode window instead of an embedded view.
Item {
  id: root
  visible: false

  property var settings: ({})

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null || value === "" ? fallback : value
  }

  readonly property string baseUrl: String(setting("baseUrl", "http://localhost:5080")).replace(/\/+$/, "")
  // Where windows open. In production one origin serves API + UI, so this
  // defaults to baseUrl; a dev stack (scripts/start.sh) serves the UI from
  // Vite on :5200 instead, which proxies /api back to the API port.
  readonly property string webBase: String(setting("webUrl", baseUrl)).replace(/\/+$/, "")
  readonly property string apiKey: String(settings && settings.apiKey ? settings.apiKey : "")
  readonly property int refreshIntervalSec: Number(setting("refreshIntervalSec", 30)) || 30
  readonly property string projectDir: String(settings && settings.projectDir ? settings.projectDir : "")
  readonly property string startCommand: String(settings && settings.startCommand ? settings.startCommand : "")
  readonly property string windowPattern: String(setting("windowPattern", "chrome-localhost__-Default"))

  property bool online: false
  property bool checking: false
  property string version: ""
  property string lastError: ""
  property var counts: null

  property string query: ""
  property bool searching: false
  property var hits: []
  property int searchSeq: 0

  readonly property bool canStart: !online && (startCommand !== "" || projectDir !== "")
  readonly property string statusText: online
    ? (version !== "" ? "v" + version + " · online" : "online")
    : (checking ? "checking…" : "offline")

  function request(path, callback) {
    var xhr = new XMLHttpRequest()
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      var body = null
      if (xhr.status === 200) {
        try { body = JSON.parse(xhr.responseText) } catch (e) { body = null }
      }
      callback(xhr.status, body)
    }
    xhr.open("GET", baseUrl + path)
    if (apiKey !== "") xhr.setRequestHeader("X-Api-Key", apiKey)
    xhr.send()
  }

  function refresh() {
    checking = true
    request("/api/health", function(status, body) {
      checking = false
      var wasOnline = online
      online = status === 200 && !!body
      if (online) version = String(body.version || "")
      lastError = online ? ""
        : (status === 0 ? "No BeeDocs server at " + baseUrl
          : "HTTP " + status + " from " + baseUrl)
      if (online) refreshCounts()
      else counts = null
      // A server that just came back should answer the query still on screen.
      if (online && !wasOnline && query !== "") search(query)
    })
  }

  function refreshCounts() {
    request("/api/search/status", function(status, body) {
      counts = status === 200 && body ? body : null
    })
  }

  function search(q) {
    query = String(q || "")
    if (query.trim() === "" || !online) {
      searchSeq++
      searching = false
      hits = []
      return
    }
    var seq = ++searchSeq
    searching = true
    request("/api/search?limit=8&q=" + encodeURIComponent(query), function(status, body) {
      if (seq !== searchSeq) return
      searching = false
      hits = status === 200 && body && body.hits ? body.hits : []
    })
  }

  function openApp() {
    Util.execArgv(["omarchy-launch-or-focus-webapp", windowPattern, webBase])
  }

  // Deep links always open a fresh app window: an already-open window can be
  // focused but not steered to another document from out here.
  function openHit(url) {
    Util.execArgv(["omarchy-launch-webapp", webBase + String(url || "")])
  }

  function startServer() {
    // An installed instance (scripts/install-omarchy.sh) is started silently
    // via its service command; a dev checkout gets a terminal running start.sh.
    if (startCommand !== "") {
      Util.execDetached(startCommand)
      return
    }
    if (projectDir === "") return
    Util.execArgv([
      "setsid", "uwsm-app", "--", "xdg-terminal-exec",
      "bash", "-lc", 'cd "$1" && exec ./scripts/start.sh', "bash", projectDir
    ])
  }

  Timer {
    interval: Math.max(5, root.refreshIntervalSec) * 1000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  onBaseUrlChanged: refresh()
  Component.onCompleted: refresh()
}
