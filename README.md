# Reddit Wallpaper Changer

A small Electron app for Windows 11 that:

- Pulls 10 matching image posts from `https://www.reddit.com/r/wallpaper/`
- Lets you choose Reddit sorting: Best, Hot, New, Top, or Rising
- Filters loaded wallpapers by common screen resolutions or your current screen
- Sets the first matching image as your desktop background
- Refreshes the 10 wallpaper options on a configurable interval, defaulting to every 24 hours
- Changes your desktop background through the loaded wallpaper options on a separate configurable interval, defaulting to every 24 hours
- Prevents either interval from being set below 1 hour
- Lets you favorite any shown wallpaper into a folder you choose
- Keeps running in the background from the Windows tray after closing or minimizing
- Includes app icon files in `assets/` for the window, tray, and future packaging

## Run

```powershell
npm install
npm start
```

The app changes the Windows wallpaper through `SystemParametersInfo` via PowerShell. It does not require a Reddit API key.

## Build a Windows installer

To build the installer locally on Windows:

```powershell
npm install
npm run dist:win
```

The installer is written to `dist/` as `Reddit Wallpaper Changer Setup 1.0.0.exe`.

## GitHub release build

After uploading this project to GitHub, create a version tag to build the Windows installer in GitHub Actions:

```powershell
git tag v1.0.0
git push origin v1.0.0
```

The workflow in `.github/workflows/release.yml` attaches the `.exe` installer to a GitHub Release and also keeps it as a workflow artifact. To publish a new version later, update the `version` in `package.json`, commit it, then push a matching tag such as `v1.0.1`.

## Upload to GitHub

This folder is ready to be uploaded with source files only. Generated folders such as `node_modules/`, `dist/`, `out/`, `build/`, and `release/` are ignored and should stay out of Git.

For a first upload from this folder:

```powershell
git init
git add .
git commit -m "Initial Reddit wallpaper changer app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/reddit-wallpaper-changer.git
git push -u origin main
```

## Notes

- The first refresh runs when the app starts and sets the first matching image.
- Closing or minimizing the window hides it to the tray so scheduled wallpaper refreshes and background changes continue. Use the tray icon to reopen the window or quit the app.
- Use **Set first match now** to fetch the selected Reddit sort and immediately apply the first matching image.
- Changing the Reddit sort or resolution refreshes the list using the new filter.
- Use **Choose folder** before favoriting, or the app will ask you to choose one when you favorite your first wallpaper.
