/*
 * MainActivity.java — Android app entry point.
 *
 * Extends Capacitor's BridgeActivity, which sets up the WebView bridge that
 * allows JavaScript in mobile/app.js to call native Java code.
 *
 * The only responsibility of this class is to register MagnetometerPlugin
 * BEFORE calling super.onCreate(). Capacitor collects registered plugins
 * during bridge initialisation (which happens inside super.onCreate()), so
 * any plugin registered after that call would be invisible to the JS side.
 *
 * All other lifecycle handling (WebView setup, Capacitor bridge init,
 * back-button behaviour, etc.) is inherited from BridgeActivity.
 */

package com.mobilemagnetometer.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register our custom magnetometer plugin so the JS side can access it
        // via window.Capacitor.Plugins.Magnetometer. Must come before super.onCreate()
        // because that is where Capacitor initialises the bridge and discovers plugins.
        registerPlugin(MagnetometerPlugin.class);

        super.onCreate(savedInstanceState);
    }
}
