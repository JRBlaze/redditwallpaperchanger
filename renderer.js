const grid = document.querySelector('#wallpaperGrid');
const template = document.querySelector('#wallpaperCardTemplate');
const statusBar = document.querySelector('#statusBar');
const refreshIntervalInput = document.querySelector('#refreshIntervalInput');
const changeIntervalInput = document.querySelector('#changeIntervalInput');
const redditSortSelect = document.querySelector('#redditSortSelect');
const resolutionSelect = document.querySelector('#resolutionSelect');
const startOnStartupInput = document.querySelector('#startOnStartupInput');
const favoriteFolder = document.querySelector('#favoriteFolder');
const refreshButton = document.querySelector('#refreshButton');
const setNewestButton = document.querySelector('#setNewestButton');
const chooseFolderButton = document.querySelector('#chooseFolderButton');
const openFolderButton = document.querySelector('#openFolderButton');

let appState = null;
let refreshIntervalSaveTimer = null;
let changeIntervalSaveTimer = null;

function formatDate(utcSeconds) {
  if (!utcSeconds) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(utcSeconds * 1000));
}

function setBusy(isBusy) {
  refreshButton.disabled = isBusy;
  setNewestButton.disabled = isBusy;
  refreshIntervalInput.disabled = isBusy;
  changeIntervalInput.disabled = isBusy;
  redditSortSelect.disabled = isBusy;
  resolutionSelect.disabled = isBusy;
  startOnStartupInput.disabled = isBusy;
}

function renderStatus(status) {
  statusBar.textContent = status?.message || 'Ready';
  statusBar.dataset.kind = status?.kind || 'idle';
  setBusy(status?.kind === 'loading');
}

function renderSettings(settings) {
  refreshIntervalInput.value = settings.refreshIntervalHours || 24;
  changeIntervalInput.value = settings.changeIntervalHours || 24;
  redditSortSelect.value = settings.redditSort || 'new';
  resolutionSelect.value = settings.resolution || 'any';
  startOnStartupInput.checked = Boolean(settings.startOnStartup);
  startOnStartupInput.disabled = appState?.platform !== 'win32';
  favoriteFolder.textContent = settings.favoriteFolder || 'No folder selected';
  favoriteFolder.title = settings.favoriteFolder || '';
  openFolderButton.disabled = !settings.favoriteFolder;
}

function cardMeta(wallpaper) {
  const parts = [`u/${wallpaper.author}`, formatDate(wallpaper.createdUtc)];
  if (wallpaper.resolution) parts.push(wallpaper.resolution);
  if (wallpaper.score) parts.push(`${wallpaper.score} points`);
  return parts.filter(Boolean).join(' · ');
}

function renderWallpapers(state) {
  grid.replaceChildren();

  if (!state.wallpapers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No wallpapers loaded yet.';
    grid.append(empty);
    return;
  }

  state.wallpapers.forEach((wallpaper) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const imageButton = node.querySelector('.image-button');
    const image = node.querySelector('img');
    const title = node.querySelector('h2');
    const meta = node.querySelector('.meta');
    const currentPill = node.querySelector('.current-pill');
    const setButton = node.querySelector('.set-button');
    const favoriteButton = node.querySelector('.favorite-button');
    const sourceButton = node.querySelector('.source-button');

    const isCurrent = state.settings.currentWallpaperId === wallpaper.id;
    const isFavorite = state.settings.favoriteIds.includes(wallpaper.id);

    image.src = wallpaper.imageUrl;
    image.alt = wallpaper.title;
    title.textContent = wallpaper.title;
    meta.textContent = cardMeta(wallpaper);
    currentPill.hidden = !isCurrent;
    favoriteButton.textContent = isFavorite ? 'Favorited' : 'Favorite';
    favoriteButton.classList.toggle('is-favorite', isFavorite);

    imageButton.addEventListener('click', () => window.wallpaperApp.setWallpaper(wallpaper.id));
    setButton.addEventListener('click', () => window.wallpaperApp.setWallpaper(wallpaper.id));
    favoriteButton.addEventListener('click', () => window.wallpaperApp.favoriteWallpaper(wallpaper.id));
    sourceButton.addEventListener('click', () => window.wallpaperApp.openLink(wallpaper.permalink));

    grid.append(node);
  });
}

function render(state) {
  appState = state;
  const currentResolutionOption = resolutionSelect.querySelector('option[value="current"]');
  if (currentResolutionOption && state.displayResolution) {
    currentResolutionOption.textContent = `Current screen (${state.displayResolution.replace('x', ' x ')})`;
  }
  renderStatus(state.status);
  renderSettings(state.settings);
  renderWallpapers(state);
}

async function run(action) {
  try {
    const nextState = await action();
    if (nextState) render(nextState);
  } catch (error) {
    renderStatus({
      kind: 'error',
      message: error.message || String(error)
    });
  }
}

refreshButton.addEventListener('click', () => run(() => window.wallpaperApp.refresh()));
setNewestButton.addEventListener('click', () => run(() => window.wallpaperApp.setNewest()));
chooseFolderButton.addEventListener('click', () => run(() => window.wallpaperApp.chooseFavoriteFolder()));
openFolderButton.addEventListener('click', () => run(() => window.wallpaperApp.openFavoriteFolder()));

function clampIntervalInput(input) {
  const intervalHours = Number(input.value);
  if (!Number.isFinite(intervalHours)) return null;
  if (intervalHours < 1) {
    input.value = '1';
    return 1;
  }
  return intervalHours;
}

refreshIntervalInput.addEventListener('input', () => {
  window.clearTimeout(refreshIntervalSaveTimer);
  refreshIntervalSaveTimer = window.setTimeout(() => {
    const refreshIntervalHours = clampIntervalInput(refreshIntervalInput);
    if (refreshIntervalHours === null) return;
    run(() => window.wallpaperApp.updateSettings({ refreshIntervalHours }));
  }, 500);
});

refreshIntervalInput.addEventListener('change', () => {
  window.clearTimeout(refreshIntervalSaveTimer);
  const refreshIntervalHours = clampIntervalInput(refreshIntervalInput);
  if (refreshIntervalHours === null) return;
  run(() => window.wallpaperApp.updateSettings({ refreshIntervalHours }));
});

changeIntervalInput.addEventListener('input', () => {
  window.clearTimeout(changeIntervalSaveTimer);
  changeIntervalSaveTimer = window.setTimeout(() => {
    const changeIntervalHours = clampIntervalInput(changeIntervalInput);
    if (changeIntervalHours === null) return;
    run(() => window.wallpaperApp.updateSettings({ changeIntervalHours }));
  }, 500);
});

changeIntervalInput.addEventListener('change', () => {
  window.clearTimeout(changeIntervalSaveTimer);
  const changeIntervalHours = clampIntervalInput(changeIntervalInput);
  if (changeIntervalHours === null) return;
  run(() => window.wallpaperApp.updateSettings({ changeIntervalHours }));
});

redditSortSelect.addEventListener('change', () => {
  run(async () => {
    await window.wallpaperApp.updateSettings({ redditSort: redditSortSelect.value });
    return window.wallpaperApp.refresh();
  });
});

resolutionSelect.addEventListener('change', () => {
  run(async () => {
    await window.wallpaperApp.updateSettings({ resolution: resolutionSelect.value });
    return window.wallpaperApp.refresh();
  });
});

startOnStartupInput.addEventListener('change', () => {
  run(() => window.wallpaperApp.updateSettings({ startOnStartup: startOnStartupInput.checked }));
});

window.wallpaperApp.onStateUpdate(render);
run(() => window.wallpaperApp.getState());
