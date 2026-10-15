// Isolated Electron scheduler/loopback RTC diagnostic; never uses app userdata.
/* oxlint-disable workjet/no-global-process-runtime -- Standalone isolated Electron diagnostic; no Effect runtime. */
const { app, BrowserWindow, WebContentsView, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const output = process.argv.at(-1);
if (!output || !path.isAbsolute(output)) throw new Error("absolute output JSON path required");
app.setPath("userData", path.join(path.dirname(output), "guest-timing-profile"));
const deadline = setTimeout(() => app.exit(2), 45000);
const page = `<!doctype html><script>
window.measure = async () => {
  const left = new RTCPeerConnection({iceServers: []});
  const right = new RTCPeerConnection({iceServers: []});
  left.onicecandidate = e => e.candidate && right.addIceCandidate(e.candidate);
  right.onicecandidate = e => e.candidate && left.addIceCandidate(e.candidate);
  const tx = left.createDataChannel('isolated-command');
  const ready = new Promise(resolve => tx.onopen = resolve);
  right.ondatachannel = e => {
    const rx = e.channel;
    rx.onmessage = m => rx.send(m.data);
  };
  await left.setLocalDescription(await left.createOffer());
  await right.setRemoteDescription(left.localDescription);
  await right.setLocalDescription(await right.createAnswer());
  await left.setRemoteDescription(right.localDescription);
  await ready;
  const started = performance.now();
  const stages = [];
  let timerStarted;
  await new Promise(resolve => {
    const send = () => {
      timerStarted = performance.now();
      setTimeout(() => {
        stages.push({timerMs: performance.now() - timerStarted});
        tx.send(JSON.stringify({id: stages.length, sentAt: performance.now()}));
      }, 50);
    };
    tx.onmessage = e => {
      const ack = JSON.parse(e.data);
      stages[stages.length - 1].rtcAckMs = performance.now() - ack.sentAt;
      if (stages.length === 6) resolve(); else send();
    };
    send();
  });
  const result = {visibility: document.visibilityState, elapsedMs: performance.now() - started,
    requestedTimerMs: 50, stages};
  tx.close(); left.close(); right.close();
  return result;
};
</script>`;
app
  .whenReady()
  .then(async () => {
    const host = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const results = [];
    try {
      await host.loadURL("data:text/html,<body>isolated host</body>");
      host.showInactive();
      for (const fixed of [false, true]) {
        const preferences = {
          session: session.fromPartition(`isolated-guest-${fixed}`),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          ...(fixed ? { backgroundThrottling: false } : {}),
        };
        const view = new WebContentsView({ webPreferences: preferences });
        try {
          host.contentView.addChildView(view);
          view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
          await view.webContents.loadURL(
            "data:text/html;charset=utf-8," + encodeURIComponent(page),
          );
          host.contentView.removeChildView(view);
          const result = await view.webContents.executeJavaScript("window.measure()");
          results.push({
            variant: fixed ? "unthrottled" : "default",
            effectiveBackgroundThrottling: view.webContents.getBackgroundThrottling(),
            ...result,
          });
        } finally {
          view.webContents.close();
        }
      }
      const report = {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        fixture: "detached view; six 50ms readiness timers; real loopback RTC",
        results,
        installedAcceptance: false,
      };
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log("guest_background_timing=" + JSON.stringify(report));
    } finally {
      host.destroy();
      clearTimeout(deadline);
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  });
