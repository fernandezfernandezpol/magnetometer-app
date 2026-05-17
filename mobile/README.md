# Mobile Magnetometer — Android App

**Version:** 1.0.0  
**Platform:** Android 5.1+ (API level 22+)  
**Built with:** [Capacitor](https://capacitorjs.com/) + custom native magnetometer plugin

The Android app reads raw X/Y/Z magnetic field values (µT) from the phone's hardware magnetometer, displays them on a live chart, and streams them over WebSocket to the PC server on the same Wi-Fi network.

---

## Install (end users)

1. Download `Mobile-Magnetometer.apk` from the [latest release](https://github.com/polfd/magnetometer-app/releases/latest).
2. Transfer the file to the phone (USB cable, cloud storage, email, etc.).
3. On the phone, go to **Settings → Install unknown apps** and allow installation from your file manager.
4. Open `Mobile-Magnetometer.apk` and tap **Install**.

---

## Connect to the PC

1. Make sure the phone and PC are on the **same Wi-Fi network**.
2. Start the PC app (or `node pc/server.js` from the repo root). The console prints the server's local IP addresses.
3. Open Mobile Magnetometer on the phone → tap **PC** in the header → enter the PC's IP (e.g. `192.168.1.45`) → tap **CONNECT**.
4. The status badge changes to **LINKED** and the magnetometer starts streaming. The IP is saved for automatic reconnect.

---

## Build from source

Requires [Node.js](https://nodejs.org) v18+ and [Android Studio](https://developer.android.com/studio).

```bash
# From the repo root
npm install                # install Capacitor CLI and core
npx cap sync android       # copy web assets from mobile/ into android/
```

Then open the `android/` folder in **Android Studio** and build:

**Build → Build Bundle(s) / APK(s) → Build APK(s)**

The debug APK is output to:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

Transfer it to the phone and install (see Install section above).

> First time in Android Studio: let Gradle sync finish (~1–2 min, downloads Capacitor dependencies).

---

## Sensor modes

The app picks a sensor backend in priority order:

| Mode | When active | Source |
|------|-------------|--------|
| `native` | Running as Android APK | `MagnetometerPlugin.java` → `SensorManager.TYPE_MAGNETIC_FIELD` |
| `generic` | Browser with HTTPS | Generic Sensor API (`new Magnetometer()`) |
| `orientation` | iOS / browser fallback | `DeviceOrientationEvent` (derived, ~50 µT assumed) |
| `sim` | Desktop / no sensor | Simulated sine wave |

The APK always uses the `native` mode, which reads directly from hardware at `SENSOR_DELAY_FASTEST` and throttles in JavaScript to the user-selected sample rate.

---

## Sample rates

Tap the Hz button in the header to cycle between **1 Hz**, **5 Hz**, and **20 Hz**.  
The sensor always runs at hardware speed; JavaScript drops frames to hit the target rate.

---

## Files in this directory

| File | Purpose |
|------|---------|
| `index.html` | App shell and UI layout |
| `app.js` | Sensor reading, chart rendering, WebSocket client, calibration |
| `styles.css` | VS Code–inspired dark theme |
| `manifest.json` | PWA manifest (icon, theme colour, orientation) |
| `sw.js` | Service worker (offline cache — unused in the APK build) |
| `compass.png` | App icon |

The `android/` directory at the repo root is the generated Capacitor/Android project. Only edit the files in `android/app/src/main/java/com/mobilemagnetometer/app/`.
