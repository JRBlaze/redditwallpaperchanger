const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { existsSync } = require('fs');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const REDDIT_BASE_URL = 'https://www.reddit.com/r/wallpaper';
const USER_AGENT = 'RedditWallpaperChanger/1.0 (+https://www.reddit.com/r/wallpaper/)';
const REDDIT_SORT_OPTIONS = new Set(['best', 'hot', 'new', 'top', 'rising']);
const RESOLUTION_OPTIONS = new Set([
  'any',
  'current',
  '1920x1080',
  '2560x1440',
  '3440x1440',
  '3840x2160'
]);
const DEFAULT_SETTINGS = {
  refreshIntervalHours: 24,
  changeIntervalHours: 24,
  startOnStartup: false,
  redditSort: 'new',
  resolution: 'any',
  favoriteFolder: '',
  currentWallpaperId: '',
  favoriteIds: []
};
const isSmokeTest = process.argv.includes('--smoke-test');
const shouldDownloadSmokeTestImage = process.env.RED_WALLPAPER_SMOKE_DOWNLOAD === '1';

let mainWindow;
let tray;
let isQuitting = false;
let settings = { ...DEFAULT_SETTINGS };
let wallpapers = [];
let refreshTimer = null;
let changeTimer = null;
let status = {
  message: 'Ready',
  kind: 'idle',
  updatedAt: ''
};

function wasStartedHidden() {
  if (process.argv.some((arg) => arg === '--startup' || arg === '--hidden')) return true;

  if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
  const loginItemSettings = app.getLoginItemSettings();
  return Boolean(loginItemSettings.wasOpenedAtLogin);
}

function userDataPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function settingsPath() {
  return userDataPath('settings.json');
}

function cacheDir() {
  return userDataPath('wallpapers');
}

function getAppIconPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'assets', 'app-icon.ico');
  }

  return path.join(__dirname, 'assets', 'app-icon.png');
}

function showMainWindow() {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.show();
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }

  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;

  const icon = nativeImage.createFromPath(getAppIconPath());
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Reddit Wallpaper Changer');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show Reddit Wallpaper Changer',
      click: showMainWindow
    },
    {
      label: 'Set first match now',
      click: () => {
        refreshWallpapers({ setNewest: true }).catch((error) => {
          setStatus(`Tray refresh failed: ${error.message}`, 'error');
        });
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('click', showMainWindow);
}

function sendState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('state:update', getPublicState());
}

function setStatus(message, kind = 'idle') {
  status = {
    message,
    kind,
    updatedAt: new Date().toISOString()
  };
  sendState();
}

function getPublicState() {
  return {
    settings,
    wallpapers,
    status,
    displayResolution: getPrimaryDisplayResolution(),
    platform: process.platform
  };
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    settings = normalizeSettings(JSON.parse(raw));
  } catch {
    settings = { ...DEFAULT_SETTINGS };
    await saveSettings();
  }
}

function normalizeSettings(nextSettings) {
  const legacyIntervalHours = Number(nextSettings.intervalHours);
  const refreshIntervalHours = Number(nextSettings.refreshIntervalHours ?? nextSettings.intervalHours);
  const changeIntervalHours = Number(nextSettings.changeIntervalHours ?? nextSettings.intervalHours);
  const { intervalHours: _legacyIntervalHours, ...cleanSettings } = nextSettings;
  const redditSort = REDDIT_SORT_OPTIONS.has(nextSettings.redditSort)
    ? nextSettings.redditSort
    : DEFAULT_SETTINGS.redditSort;
  const resolution = RESOLUTION_OPTIONS.has(nextSettings.resolution)
    ? nextSettings.resolution
    : DEFAULT_SETTINGS.resolution;
  return {
    ...DEFAULT_SETTINGS,
    ...cleanSettings,
    refreshIntervalHours: normalizeIntervalHours(refreshIntervalHours, legacyIntervalHours),
    changeIntervalHours: normalizeIntervalHours(changeIntervalHours, legacyIntervalHours),
    startOnStartup: Boolean(nextSettings.startOnStartup),
    redditSort,
    resolution,
    favoriteIds: Array.isArray(nextSettings.favoriteIds) ? nextSettings.favoriteIds : []
  };
}

function quoteDesktopExecArg(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function linuxAutostartPath() {
  return path.join(app.getPath('home'), '.config', 'autostart', 'reddit-wallpaper-changer.desktop');
}

async function applyLinuxStartOnStartupSetting() {
  const autostartPath = linuxAutostartPath();

  if (!settings.startOnStartup) {
    await fs.rm(autostartPath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(autostartPath), { recursive: true });
  const desktopEntry = [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Reddit Wallpaper Changer',
    'Comment=Change the desktop wallpaper from r/wallpaper',
    `Exec=${quoteDesktopExecArg(process.execPath)} --hidden`,
    `Icon=${getAppIconPath()}`,
    'Terminal=false',
    'Categories=Utility;',
    'X-GNOME-Autostart-enabled=true'
  ].join('\n');
  await fs.writeFile(autostartPath, `${desktopEntry}\n`, 'utf8');
}

async function applyStartOnStartupSetting() {
  if (process.platform === 'linux') {
    await applyLinuxStartOnStartupSetting();
    return;
  }

  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({
    openAtLogin: Boolean(settings.startOnStartup),
    openAsHidden: true,
    path: process.execPath,
    args: ['--hidden']
  });
}

function normalizeIntervalHours(value, fallbackValue = 24) {
  if (Number.isFinite(value)) return Math.max(1, value);
  if (Number.isFinite(fallbackValue)) return Math.max(1, fallbackValue);
  return 24;
}

async function saveSettings() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function hoursToIntervalMs(hours) {
  return Math.max(60 * 60 * 1000, hours * 60 * 60 * 1000);
}

function scheduleTimers() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (changeTimer) clearInterval(changeTimer);

  refreshTimer = setInterval(() => {
    refreshWallpapers({ setNewest: false }).catch((error) => {
      setStatus(`Automatic refresh failed: ${error.message}`, 'error');
    });
  }, hoursToIntervalMs(settings.refreshIntervalHours));

  changeTimer = setInterval(() => {
    changeToNextWallpaper().catch((error) => {
      setStatus(`Automatic background change failed: ${error.message}`, 'error');
    });
  }, hoursToIntervalMs(settings.changeIntervalHours));
}

function getPrimaryDisplayResolution() {
  try {
    const display = screen.getPrimaryDisplay();
    const scaleFactor = display.scaleFactor || 1;
    const width = Math.round(display.size.width * scaleFactor);
    const height = Math.round(display.size.height * scaleFactor);
    return `${width}x${height}`;
  } catch {
    return '';
  }
}

function selectedResolution() {
  if (settings.resolution === 'current') return getPrimaryDisplayResolution();
  return settings.resolution;
}

function redditSortLabel() {
  return settings.redditSort.charAt(0).toUpperCase() + settings.redditSort.slice(1);
}

function redditListingUrl() {
  const url = new URL(`${REDDIT_BASE_URL}/${settings.redditSort}.json`);
  url.searchParams.set('limit', '100');
  url.searchParams.set('raw_json', '1');
  return url.toString();
}

async function fetchRedditJson() {
  const response = await fetch(redditListingUrl(), {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Reddit returned ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function htmlDecode(value) {
  return String(value || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function imageExtensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\.(jpe?g|png|webp)$/i);
    return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : '';
  } catch {
    return '';
  }
}

function firstGalleryImage(post) {
  if (!post.gallery_data || !post.media_metadata) return null;
  const item = post.gallery_data.items?.[0];
  if (!item) return null;
  const media = post.media_metadata[item.media_id];
  if (!media || media.status !== 'valid') return null;
  const source = media.s || media.p?.at(-1);
  return source?.u ? htmlDecode(source.u) : null;
}

function postImageUrl(post) {
  const directUrl = htmlDecode(post.url_overridden_by_dest || post.url);
  if (directUrl && imageExtensionFromUrl(directUrl)) return directUrl;

  const galleryUrl = firstGalleryImage(post);
  if (galleryUrl) return galleryUrl;

  const preview = post.preview?.images?.[0]?.source?.url;
  if (preview) return htmlDecode(preview);

  return null;
}

function toWallpaper(post) {
  const imageUrl = postImageUrl(post);
  if (!imageUrl) return null;
  const source = post.preview?.images?.[0]?.source;

  return {
    id: post.id,
    title: post.title || 'Untitled wallpaper',
    author: post.author || 'unknown',
    permalink: `https://www.reddit.com${post.permalink}`,
    createdUtc: post.created_utc,
    imageUrl,
    cachedPath: '',
    score: post.score || 0,
    width: source?.width || 0,
    height: source?.height || 0,
    resolution: source ? `${source.width} x ${source.height}` : ''
  };
}

function matchesSelectedResolution(wallpaper) {
  const resolution = selectedResolution();
  if (!resolution || resolution === 'any') return true;
  return `${wallpaper.width}x${wallpaper.height}` === resolution;
}

async function refreshWallpapers({ setNewest = false } = {}) {
  const resolution = selectedResolution();
  const resolutionLabel = resolution === 'any' ? 'any resolution' : resolution.replace('x', ' x ');
  setStatus(`Fetching ${redditSortLabel()} wallpapers from r/wallpaper at ${resolutionLabel}...`, 'loading');
  const payload = await fetchRedditJson();
  const posts = payload?.data?.children?.map((child) => child.data).filter(Boolean) || [];
  wallpapers = posts.map(toWallpaper).filter(Boolean).filter(matchesSelectedResolution).slice(0, 10);

  if (!wallpapers.length) {
    throw new Error(`No image posts matched ${redditSortLabel()} at ${resolutionLabel}.`);
  }

  setStatus(`Loaded ${wallpapers.length} ${redditSortLabel()} image posts at ${resolutionLabel}.`, 'success');

  if (setNewest) {
    await setWallpaperById(wallpapers[0].id);
  }

  sendState();
  return getPublicState();
}

function slugify(value) {
  return String(value || 'wallpaper')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/\s/g, '-')
    .toLowerCase() || 'wallpaper';
}

function extensionFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  return '.jpg';
}

async function downloadWallpaper(wallpaper) {
  if (wallpaper.cachedPath && existsSync(wallpaper.cachedPath)) {
    return wallpaper.cachedPath;
  }

  await fs.mkdir(cacheDir(), { recursive: true });
  const response = await fetch(wallpaper.imageUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5'
    }
  });

  if (!response.ok) {
    throw new Error(`Image download failed with ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type');
  const rawBuffer = Buffer.from(await response.arrayBuffer());
  const image = nativeImage.createFromBuffer(rawBuffer);
  const ext = image.isEmpty()
    ? imageExtensionFromUrl(wallpaper.imageUrl) || extensionFromContentType(contentType)
    : '.png';
  const filePath = path.join(cacheDir(), `${wallpaper.id}-${slugify(wallpaper.title)}${ext}`);
  const buffer = image.isEmpty() ? rawBuffer : image.toPNG();
  await fs.writeFile(filePath, buffer);

  wallpaper.cachedPath = filePath;
  return filePath;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function runFirstSuccessful(commands) {
  const errors = [];

  for (const command of commands) {
    try {
      await command.run();
      return command.label;
    } catch (error) {
      errors.push(`${command.label}: ${error.message}`);
    }
  }

  throw new Error(`No supported wallpaper setter worked. Tried ${errors.join('; ')}`);
}

function setWindowsWallpaper(filePath) {
  return new Promise((resolve, reject) => {
    const script = `
$signature = @"
using System;
using System.Runtime.InteropServices;
public static class WallpaperApi {
  [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
"@
Add-Type -TypeDefinition $signature
$ok = [WallpaperApi]::SystemParametersInfo(20, 0, $env:WALLPAPER_PATH, 3)
if (-not $ok) {
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "SystemParametersInfo failed with Win32 error $errorCode"
}
`;

    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        env: {
          ...process.env,
          WALLPAPER_PATH: filePath
        },
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || stdout.trim() || error.message));
          return;
        }
        resolve();
      }
    );
  });
}

function setMacOSWallpaper(filePath) {
  const script = `
tell application "System Events"
  repeat with currentDesktop in desktops
    set picture of currentDesktop to POSIX file "${filePath.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"
  end repeat
end tell
`;

  return runCommand('osascript', ['-e', script]);
}

function gsettingsCommand(schema, key, value, desktop) {
  return {
    label: `gsettings ${schema} ${key}`,
    desktop,
    run: () => runCommand('gsettings', ['set', schema, key, value])
  };
}

function gnomeWallpaperCommand(fileUri) {
  return {
    label: 'gsettings GNOME wallpaper',
    desktop: 'gnome',
    run: async () => {
      await runCommand('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', fileUri]);
      await runCommand('gsettings', [
        'set',
        'org.gnome.desktop.background',
        'picture-uri-dark',
        fileUri
      ]).catch(() => undefined);
    }
  };
}

function kdeWallpaperScript(fileUri) {
  return `
const wallpaper = ${JSON.stringify(fileUri)};
for (const desktop of desktops()) {
  desktop.wallpaperPlugin = 'org.kde.image';
  desktop.currentConfigGroup = ['Wallpaper', 'org.kde.image', 'General'];
  desktop.writeConfig('Image', wallpaper);
}
`;
}

function kdeQdbusWallpaperCommand(command, script) {
  return {
    label: `${command} KDE Plasma wallpaper`,
    desktop: 'kde',
    run: () => runCommand(command, [
      'org.kde.plasmashell',
      '/PlasmaShell',
      'org.kde.PlasmaShell.evaluateScript',
      script
    ])
  };
}

function kdeGdbusWallpaperCommand(script) {
  return {
    label: 'gdbus KDE Plasma wallpaper',
    desktop: 'kde',
    run: () => runCommand('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.kde.plasmashell',
      '--object-path',
      '/PlasmaShell',
      '--method',
      'org.kde.PlasmaShell.evaluateScript',
      script
    ])
  };
}

function kdeBusctlWallpaperCommand(script) {
  return {
    label: 'busctl KDE Plasma wallpaper',
    desktop: 'kde',
    run: () => runCommand('busctl', [
      '--user',
      'call',
      'org.kde.plasmashell',
      '/PlasmaShell',
      'org.kde.PlasmaShell',
      'evaluateScript',
      's',
      script
    ])
  };
}

async function setXfceWallpaper(filePath) {
  const { stdout } = await runCommand('xfconf-query', ['-c', 'xfce4-desktop', '-l']);
  const imageProperties = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('/last-image'));

  if (!imageProperties.length) {
    throw new Error('No XFCE desktop wallpaper properties were found.');
  }

  for (const property of imageProperties) {
    await runCommand('xfconf-query', ['-c', 'xfce4-desktop', '-p', property, '-s', filePath]);
  }
}

function getLinuxDesktopNames() {
  const desktopNames = [
    process.env.XDG_CURRENT_DESKTOP,
    process.env.DESKTOP_SESSION,
    process.env.GDMSESSION
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(':'))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (process.env.KDE_FULL_SESSION === 'true') desktopNames.push('kde');
  return [...new Set(desktopNames)];
}

function commandDesktopPriority(command, desktopNames) {
  const desktop = command.desktop;
  if (!desktop) return 50;
  if (desktopNames.includes(desktop)) return 0;
  if (desktopNames.some((name) => name.includes(desktop))) return 0;
  if (desktop === 'kde' && desktopNames.some((name) => name.includes('plasma'))) return 0;
  return 100;
}

function sortLinuxWallpaperCommands(commands) {
  const desktopNames = getLinuxDesktopNames();
  return commands
    .map((command, index) => ({ command, index }))
    .sort((a, b) => {
      const priorityDifference = commandDesktopPriority(a.command, desktopNames)
        - commandDesktopPriority(b.command, desktopNames);
      return priorityDifference || a.index - b.index;
    })
    .map(({ command }) => command);
}

async function setLinuxWallpaper(filePath) {
  const fileUri = pathToFileURL(filePath).toString();
  const kdeScript = kdeWallpaperScript(fileUri);
  const commands = sortLinuxWallpaperCommands([
    gnomeWallpaperCommand(fileUri),
    gsettingsCommand('org.cinnamon.desktop.background', 'picture-uri', fileUri, 'cinnamon'),
    gsettingsCommand('org.mate.background', 'picture-filename', filePath, 'mate'),
    kdeQdbusWallpaperCommand('qdbus6', kdeScript),
    kdeQdbusWallpaperCommand('qdbus', kdeScript),
    kdeGdbusWallpaperCommand(kdeScript),
    kdeBusctlWallpaperCommand(kdeScript),
    {
      label: 'xfconf-query XFCE wallpaper',
      desktop: 'xfce',
      run: () => setXfceWallpaper(filePath)
    },
    {
      label: 'pcmanfm wallpaper',
      desktop: 'lxde',
      run: () => runCommand('pcmanfm', ['--set-wallpaper', filePath])
    },
    {
      label: 'pcmanfm-qt wallpaper',
      desktop: 'lxqt',
      run: () => runCommand('pcmanfm-qt', ['--set-wallpaper', filePath])
    }
  ]);

  return runFirstSuccessful(commands);
}

async function setDesktopWallpaper(filePath) {
  if (process.platform === 'win32') {
    await setWindowsWallpaper(filePath);
    return 'Windows desktop background';
  }

  if (process.platform === 'darwin') {
    await setMacOSWallpaper(filePath);
    return 'macOS desktop picture';
  }

  if (process.platform === 'linux') {
    const setter = await setLinuxWallpaper(filePath);
    return `Linux desktop background (${setter})`;
  }

  throw new Error(`Wallpaper changing is not supported on ${process.platform}.`);
}

async function setWallpaperById(id) {
  const wallpaper = wallpapers.find((item) => item.id === id);
  if (!wallpaper) {
    throw new Error('That wallpaper is not in the current list.');
  }

  setStatus(`Downloading "${wallpaper.title}"...`, 'loading');
  const filePath = await downloadWallpaper(wallpaper);

  setStatus('Setting the desktop background...', 'loading');
  const desktopLabel = await setDesktopWallpaper(filePath);
  settings.currentWallpaperId = wallpaper.id;
  await saveSettings();
  setStatus(`${desktopLabel} set to "${wallpaper.title}".`, 'success');
  sendState();
  return getPublicState();
}

async function changeToNextWallpaper() {
  if (!wallpapers.length) {
    await refreshWallpapers({ setNewest: false });
  }

  if (!wallpapers.length) {
    throw new Error('No wallpapers are loaded yet.');
  }

  const currentIndex = wallpapers.findIndex((item) => item.id === settings.currentWallpaperId);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % wallpapers.length : 0;
  await setWallpaperById(wallpapers[nextIndex].id);
  return getPublicState();
}

async function favoriteWallpaperById(id) {
  const wallpaper = wallpapers.find((item) => item.id === id);
  if (!wallpaper) {
    throw new Error('That wallpaper is not in the current list.');
  }

  if (!settings.favoriteFolder) {
    await chooseFavoriteFolder();
  }

  if (!settings.favoriteFolder) {
    throw new Error('Choose a favorites folder before saving wallpapers.');
  }

  await fs.mkdir(settings.favoriteFolder, { recursive: true });
  setStatus(`Saving "${wallpaper.title}" to favorites...`, 'loading');
  const sourcePath = await downloadWallpaper(wallpaper);
  const ext = path.extname(sourcePath) || '.jpg';
  const destination = path.join(
    settings.favoriteFolder,
    `${wallpaper.id}-${slugify(wallpaper.title)}${ext}`
  );

  await fs.copyFile(sourcePath, destination);
  if (!settings.favoriteIds.includes(wallpaper.id)) {
    settings.favoriteIds.push(wallpaper.id);
    await saveSettings();
  }

  setStatus(`Saved favorite to ${destination}`, 'success');
  sendState();
  return getPublicState();
}

async function chooseFavoriteFolder() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for favorite wallpapers',
    properties: ['openDirectory', 'createDirectory']
  });

  if (!result.canceled && result.filePaths[0]) {
    settings.favoriteFolder = result.filePaths[0];
    await saveSettings();
    setStatus(`Favorites folder set to ${settings.favoriteFolder}`, 'success');
    sendState();
  }

  return getPublicState();
}

async function updateSettings(nextSettings) {
  settings = normalizeSettings({
    ...settings,
    ...nextSettings
  });
  await saveSettings();
  if (Object.hasOwn(nextSettings, 'startOnStartup')) {
    await applyStartOnStartupSetting();
  }
  scheduleTimers();
  if (Object.hasOwn(nextSettings, 'refreshIntervalHours')) {
    setStatus(`Wallpaper options refresh every ${settings.refreshIntervalHours} hours.`, 'success');
  } else if (Object.hasOwn(nextSettings, 'changeIntervalHours')) {
    setStatus(`Desktop background changes every ${settings.changeIntervalHours} hours.`, 'success');
  } else if (Object.hasOwn(nextSettings, 'startOnStartup')) {
    setStatus(
      settings.startOnStartup
        ? 'App will start automatically and stay hidden in the tray when you sign in.'
        : 'App will no longer start automatically when you sign in.',
      'success'
    );
  } else {
    setStatus('Wallpaper filters updated.', 'success');
  }
  sendState();
  return getPublicState();
}

function createWindow() {
  const showOnLaunch = !isSmokeTest && !wasStartedHidden();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 920,
    minHeight: 680,
    show: showOnLaunch,
    backgroundColor: '#f7f4ee',
    title: 'Reddit Wallpaper Changer',
    icon: getAppIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (event) => {
    if (isQuitting || isSmokeTest) return;

    event.preventDefault();
    mainWindow.hide();
    setStatus('Running in the background. Use the tray icon to reopen or quit.', 'success');
  });

  mainWindow.on('minimize', (event) => {
    if (isSmokeTest) return;

    event.preventDefault();
    mainWindow.hide();
    setStatus('Running in the background. Use the tray icon to reopen or quit.', 'success');
  });
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.local.reddit-wallpaper-changer');
  await loadSettings();
  await applyStartOnStartupSetting();
  if (process.platform === 'darwin' && app.dock && wasStartedHidden()) {
    app.dock.hide();
  }
  createTray();
  createWindow();
  scheduleTimers();
  const setNewestOnStartup = process.env.RED_WALLPAPER_SKIP_STARTUP_APPLY !== '1';
  refreshWallpapers({ setNewest: setNewestOnStartup }).then(async () => {
    if (isSmokeTest && shouldDownloadSmokeTestImage && wallpapers[0]) {
      await downloadWallpaper(wallpapers[0]);
    }
    if (isSmokeTest) app.exit(0);
  }).catch((error) => {
    setStatus(`Startup refresh failed: ${error.message}`, 'error');
    if (isSmokeTest) app.exit(1);
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (isQuitting || isSmokeTest) app.quit();
});

app.on('activate', () => {
  showMainWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
});

ipcMain.handle('state:get', () => getPublicState());
ipcMain.handle('wallpapers:refresh', () => refreshWallpapers({ setNewest: false }));
ipcMain.handle('wallpapers:setNewest', () => refreshWallpapers({ setNewest: true }));
ipcMain.handle('wallpapers:set', (_event, id) => setWallpaperById(id));
ipcMain.handle('wallpapers:favorite', (_event, id) => favoriteWallpaperById(id));
ipcMain.handle('settings:update', (_event, nextSettings) => updateSettings(nextSettings));
ipcMain.handle('favorites:chooseFolder', () => chooseFavoriteFolder());
ipcMain.handle('favorites:openFolder', async () => {
  if (settings.favoriteFolder) await shell.openPath(settings.favoriteFolder);
  return getPublicState();
});
ipcMain.handle('links:open', async (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    await shell.openExternal(url);
  }
});
