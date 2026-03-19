// Agentorum — Electron main process
// Starts the HTTP/WebSocket server in-process, then opens a BrowserWindow
// pointed at http://127.0.0.1:<port>.  No separate Node.js binary required.

import { app, BrowserWindow, Menu, dialog, shell, ipcMain } from 'electron';
import { fileURLToPath }                                      from 'node:url';
import http                                                   from 'node:http';
import path                                                   from 'node:path';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const SERVER_MODULE = path.resolve(__dirname, '../server/server.mjs');
const DEFAULT_PORT  = 3737;

let mainWindow  = null;
let serverReady = false;

// ---------------------------------------------------------------------------
// Poll until the HTTP server is accepting connections
// ---------------------------------------------------------------------------
function waitForServer(port, maxWaitMs = 20_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxWaitMs;
    function attempt() {
      http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Agentorum server did not start within ${maxWaitMs}ms`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    }
    attempt();
  });
}

// ---------------------------------------------------------------------------
// BrowserWindow
// ---------------------------------------------------------------------------
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width:  1440,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title: 'Agentorum',
    icon:  path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      // No preload needed — UI talks to backend over HTTP/WS only
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // Open all target="_blank" links in the system browser, not a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------
function buildMenu(port) {
  const isMac = process.platform === 'darwin';

  const template = [
    // macOS app menu
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),

    {
      label: 'File',
      submenu: [
        {
          label:       'Open Debate Config…',
          accelerator: 'CmdOrCtrl+O',
          async click() {
            const result = await dialog.showOpenDialog(mainWindow, {
              title:      'Open Agentorum Config File',
              buttonLabel:'Open',
              filters: [{ name: 'Agentorum Config', extensions: ['json'] }],
              properties: ['openFile'],
            });
            if (!result.canceled && result.filePaths[0]) {
              const configPath = result.filePaths[0];
              // POST the new config path to the server; server reloads & broadcasts
              const body = JSON.stringify({ configPath });
              const req  = http.request(
                { hostname: '127.0.0.1', port, path: '/api/reload', method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
                (res) => { res.resume(); mainWindow?.reload(); }
              );
              req.on('error', () => {
                dialog.showErrorBox('Could not switch config',
                  'The server did not accept the new config path. Please restart Agentorum.');
              });
              req.write(body);
              req.end();
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Open Chatlog in Editor',
          accelerator: 'CmdOrCtrl+E',
          async click() {
            // Ask server for the current chatlog path
            http.get(`http://127.0.0.1:${port}/api/config`, (res) => {
              let buf = '';
              res.on('data', d => { buf += d; });
              res.on('end', () => {
                try {
                  const cfg = JSON.parse(buf);
                  if (cfg.chatlog) shell.openPath(cfg.chatlog);
                } catch { /* ignore */ }
              });
            }).on('error', () => {});
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },

    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },

    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },

    {
      label: 'Help',
      submenu: [
        { label: 'Agentorum on GitHub',
          click() { shell.openExternal('https://github.com/khub-ai/agentorum'); } },
        { label: 'Documentation',
          click() { shell.openExternal('https://github.com/khub-ai/agentorum/wiki'); } },
        { type: 'separator' },
        { label: 'Report an Issue',
          click() { shell.openExternal('https://github.com/khub-ai/agentorum/issues'); } },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  // Parse optional --config CLI argument passed to Electron
  const argv       = process.argv.slice(app.isPackaged ? 1 : 2);
  const cfgIdx     = argv.indexOf('--config');
  const configPath = cfgIdx !== -1 && argv[cfgIdx + 1] ? argv[cfgIdx + 1] : null;

  // Dynamically import the server module and call its exported startServer()
  // The server runs inside this same Node.js process — no child process needed.
  let startServer;
  try {
    ({ startServer } = await import(SERVER_MODULE));
  } catch (err) {
    dialog.showErrorBox('Startup error', `Failed to load server module:\n${err.message}`);
    app.quit();
    return;
  }

  try {
    await startServer({ configPath, electron: true });
  } catch (err) {
    dialog.showErrorBox('Server error', `Agentorum server failed to start:\n${err.message}`);
    app.quit();
    return;
  }

  // Wait for HTTP server to be ready before opening the window
  try {
    await waitForServer(DEFAULT_PORT);
  } catch (err) {
    dialog.showErrorBox('Timeout', err.message);
    app.quit();
    return;
  }

  buildMenu(DEFAULT_PORT);
  createWindow(DEFAULT_PORT);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(DEFAULT_PORT);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
