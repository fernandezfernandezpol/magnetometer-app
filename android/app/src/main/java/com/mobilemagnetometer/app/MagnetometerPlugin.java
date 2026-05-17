/*
 * MagnetometerPlugin.java — Capacitor plugin for raw magnetometer access.
 *
 * Why this plugin exists:
 *   The browser's Generic Sensor API (`new Magnetometer()`) requires a secure
 *   context (HTTPS or localhost). The Mobile Magnetometer server no longer uses TLS, so
 *   the web app running inside the Capacitor WebView cannot use that API.
 *   This plugin bypasses the WebView entirely and reads TYPE_MAGNETIC_FIELD
 *   directly from Android's SensorManager, giving true raw µT values at the
 *   maximum hardware sampling rate.
 *
 * JS usage (from app.js):
 *   const Mag = window.Capacitor.Plugins.Magnetometer;
 *   const handle = await Mag.addListener('reading', ({ x, y, z }) => { ... });
 *   await Mag.start();
 *   // later:
 *   handle.remove();
 *   await Mag.stop();
 *
 * The plugin name "Magnetometer" (set in @CapacitorPlugin) must match the
 * string used in window.Capacitor.Plugins.Magnetometer on the JS side.
 * MainActivity.java registers this class with registerPlugin() before
 * super.onCreate() so Capacitor can discover it at bridge initialisation.
 */

package com.mobilemagnetometer.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Magnetometer")
public class MagnetometerPlugin extends Plugin implements SensorEventListener {

    // SensorManager is the Android system service that provides access to
    // hardware sensors. It is obtained once in start() and reused in stop().
    private SensorManager sensorManager;

    // Reference to the magnetic field sensor hardware. Null if the device
    // does not have a magnetometer (rare but possible on some tablets).
    private Sensor sensor;

    /**
     * Registers a SensorEventListener for TYPE_MAGNETIC_FIELD and begins
     * delivering readings at the fastest rate the hardware supports.
     *
     * JS-side throttling in startNative() (app.js) enforces the user-selected
     * sample rate (1 / 5 / 20 Hz) so the hardware can always run at max speed
     * without flooding the WebSocket connection.
     *
     * Rejects the PluginCall if no magnetometer hardware is available,
     * which causes the JS fallback (startSim) to be invoked.
     */
    @PluginMethod
    public void start(PluginCall call) {
        sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        sensor = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);

        if (sensor == null) {
            // Reject propagates to the catch block in startNative() in app.js,
            // which triggers fallbackSim() so the app stays usable.
            call.reject("No magnetometer sensor available on this device");
            return;
        }

        // SENSOR_DELAY_FASTEST: deliver events as fast as hardware allows.
        // The JS side decides how many of those readings to actually process.
        sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_FASTEST);
        call.resolve();
    }

    /**
     * Unregisters the SensorEventListener, stopping hardware polling.
     * Called when the WebSocket to the PC disconnects (stopMeasuring in app.js).
     * Not calling stop() would keep the sensor running in the background,
     * draining battery unnecessarily.
     */
    @PluginMethod
    public void stop(PluginCall call) {
        if (sensorManager != null) {
            sensorManager.unregisterListener(this);
        }
        call.resolve();
    }

    /**
     * Called by Android on every new sensor reading.
     *
     * event.values for TYPE_MAGNETIC_FIELD:
     *   [0] = X  — magnetic field along the phone's X axis (µT, right = positive)
     *   [1] = Y  — magnetic field along the phone's Y axis (µT, up   = positive)
     *   [2] = Z  — magnetic field along the phone's Z axis (µT, out  = positive)
     *
     * notifyListeners() forwards this to the 'reading' event in JS, where
     * the startNative() handler in app.js picks it up.
     */
    @Override
    public void onSensorChanged(SensorEvent event) {
        JSObject data = new JSObject();
        data.put("x", (double) event.values[0]);
        data.put("y", (double) event.values[1]);
        data.put("z", (double) event.values[2]);
        notifyListeners("reading", data);
    }

    /**
     * Called when the sensor's accuracy changes (e.g. ACCURACY_LOW → ACCURACY_HIGH
     * after a figure-eight calibration gesture). We don't act on accuracy changes —
     * raw values are always forwarded and the user can re-zero if needed.
     */
    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // intentionally empty
    }
}
