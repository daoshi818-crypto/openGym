package ch.duartesantos.opengym;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/**
 * 手表连接（BLE 中心设备）：扫描 → 连接手表的 GATT 服务端 → 推计划 / 收完成事件。
 *
 * 手表侧（BlueOS 应用，见仓库 watch-app/）做外围设备：
 *   服务   0000a100-0000-1000-8000-00805f9b34fb
 *   计划   0000a101-…  write        手机 → 手表，今天的训练 JSON，\n 结尾
 *   完成   0000a102-…  notify       手表 → 手机，完成一组/结束训练，分片 \n 收尾
 *   状态   0000a103-…  read/write   hello 握手 / ack 确认
 *
 * 分片：BLE 默认 MTU 23（净荷 20 字节），两端都按"字节流 + \n 定界"重组，
 * 与 watch-app/src/lib/ble.js 的规则一致。
 */
@CapacitorPlugin(name = "WatchBle", permissions = {
        @Permission(strings = { Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT }, alias = "watchBle"),
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION }, alias = "watchBleLegacy"),
})
public class WatchBlePlugin extends Plugin {
    private static final UUID SVC = UUID.fromString("0000a100-0000-1000-8000-00805f9b34fb");
    private static final UUID C_PLAN = UUID.fromString("0000a101-0000-1000-8000-00805f9b34fb");
    private static final UUID C_EVENT = UUID.fromString("0000a102-0000-1000-8000-00805f9b34fb");
    private static final UUID C_STATUS = UUID.fromString("0000a103-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final int MTU = 185; // 一条 plan 消息往往超过 20 字节；协商一次 MTU，失败也能按 20 分片走

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic planChar;
    private PluginCall pendingPermCall;
    private boolean scanning;
    private boolean subscribed; // 完成特征值的 CCCD 订阅是否已生效
    private final StringBuilder rx = new StringBuilder(); // 完成特征值的重组缓冲
    private final List<byte[]> planQueue = new ArrayList<>(); // 计划分片写队列

    @Override
    public void load() {
        super.load();
        Context appCtx = ctx.getApplicationContext();
        BluetoothManager mgr = (BluetoothManager) appCtx.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = mgr == null ? null : mgr.getAdapter();
    }

    @Override
    protected void handleOnDestroy() {
        disconnectInternal();
        super.handleOnDestroy();
    }

    // ---- 权限：Android 12+ 要 BLUETOOTH_SCAN/CONNECT 运行时申请 ----

    private static String[] blePermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[] {
                    Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT };
        }
        return new String[] { Manifest.permission.ACCESS_FINE_LOCATION };
    }

    private boolean hasPerms() {
        for (String p : blePermissions()) {
            if (ContextCompat.checkSelfPermission(getContext(), p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    private boolean granted(int[] results) {
        return results != null && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
    }

    @PermissionCallback
    private void onPermResult(PluginCall call, String alias, int[] results) {
        if (call == null) return;
        if (granted(results)) {
            call.resolve(new JSObject().put("granted", true));
        } else {
            call.resolve(new JSObject().put("granted", false));
        }
    }

    /** 蓝牙可用且权限齐全？granted=false 时 JS 引导用户去开蓝牙/授权。 */
    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        boolean hw = adapter != null && adapter.isEnabled();
        ret.put("granted", hw && hasPerms());
        ret.put("bluetoothOn", hw);
        ret.put("permission", hasPerms());
        call.resolve(ret);
    }

    /** 运行时申请权限（Android 12+）；已授权直接返回 true。 */
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (adapter == null || !adapter.isEnabled()) {
            call.resolve(new JSObject().put("granted", false).put("bluetoothOn", false));
            return;
        }
        if (hasPerms()) {
            call.resolve(new JSObject().put("granted", true));
            return;
        }
        pendingPermCall = call;
        String alias = Build.VERSION.SDK_INT >= 31 ? "watchBle" : "watchBleLegacy";
        requestPermissionForAlias(alias, call, "onPermResult");
    }

    // ---- 扫描：按服务 UUID 过滤，找到就回调 deviceFound（不带地址，只做"手表在不在"） ----

    private final ScanCallback scanCb = new ScanCallback() {
        @Override
        public void onScanResult(int type, ScanResult r) {
            if (!scanning) return;
            stopScan();
            JSObject data = new JSObject();
            if (hasPerms()) data.put("name", safeName(r.getDevice()));
            data.put("found", true);
            notifyListeners("deviceFound", data);
        }

        @Override
        public void onScanFailed(int code) {
            scanning = false;
            notifyListeners("scanFailed", new JSObject().put("code", code));
        }
    };

    private String safeName(BluetoothDevice d) {
        try { return d.getName(); } catch (SecurityException e) { return null; }
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        if (!hasPerms()) { call.reject("permission missing"); return; }
        if (adapter == null || !adapter.isEnabled() || adapter.getBluetoothLeScanner() == null) {
            call.reject("bluetooth off");
            return;
        }
        if (scanning) { call.resolve(); return; }
        try {
            scanner = adapter.getBluetoothLeScanner();
            List<ScanFilter> filters = Collections.singletonList(
                    new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SVC)).build());
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
            scanning = true;
            scanner.startScan(filters, settings, scanCb);
            call.resolve();
        } catch (Exception e) {
            scanning = false;
            call.reject("scan failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopScan(PluginCall call) {
        stopScan();
        call.resolve();
    }

    private void stopScan() {
        if (scanning && scanner != null) {
            try { scanner.stopScan(scanCb); } catch (Exception ignored) { }
        }
        scanning = false;
    }

    // ---- 连接与 GATT ----

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                g.requestMtu(MTU);
                notifyState("connected");
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                notifyState("disconnected");
                cleanupGatt();
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) g.discoverServices();
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                notifyState("error");
                return;
            }
            BluetoothGattService svc = g.getService(SVC);
            if (svc == null) {
                notifyState("error");
                return;
            }
            planChar = svc.getCharacteristic(C_PLAN);
            BluetoothGattCharacteristic event = svc.getCharacteristic(C_EVENT);
            BluetoothGattCharacteristic statusChar = svc.getCharacteristic(C_STATUS);
            if (event != null) enableNotify(g, event);
            // 握手：读一次状态特征值让手表知道我们是谁（手表端只记 pending 数）
            if (statusChar != null) g.readCharacteristic(statusChar);
            notifyState("ready");
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            if (C_EVENT.equals(c.getUuid())) feedEvent(value);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (C_PLAN.equals(c.getUuid())) writeNextChunk(g);
        }
    };

    @SuppressWarnings("MissingPermission")
    private void enableNotify(BluetoothGatt g, BluetoothGattCharacteristic c) {
        g.setCharacteristicNotification(c, true);
        BluetoothGattDescriptor d = c.getDescriptor(CCCD);
        if (d != null) {
            d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            g.writeDescriptor(d);
        }
        subscribed = true;
    }

    private void notifyState(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        if (gatt != null && hasPerms()) data.put("name", safeName(gatt.getDevice()));
        notifyListeners("watchState", data);
    }

    /** 完成特征值的字节流重组：\n 定界一条 JSON（与手表端 ble.js 同一规则）。 */
    private void feedEvent(byte[] chunk) {
        if (chunk == null) return;
        String s = new String(chunk, StandardCharsets.UTF_8);
        int idx;
        while ((idx = s.indexOf('\n')) >= 0) {
            rx.append(s, 0, idx);
            emitLine(rx.toString());
            rx.setLength(0);
            s = s.substring(idx + 1);
        }
        rx.append(s);
        if (rx.length() > 8192) rx.setLength(0); // 脏数据兜底
    }

    private void emitLine(String line) {
        line = line.trim();
        if (line.isEmpty()) return;
        try {
            JSObject msg = JSObject.fromJSONObject(new org.json.JSONObject(line));
            notifyListeners("watchEvent", msg);
        } catch (Exception ignored) { /* 半包/坏包丢弃 */ }
    }

    // ---- JS API：连接 / 推计划 / 断开 ----

    @PluginMethod
    public void connect(PluginCall call) {
        if (!hasPerms()) { call.reject("permission missing"); return; }
        String address = call.getString("address");
        BluetoothDevice device = null;
        if (address != null && !address.isEmpty()) {
            try { device = adapter.getRemoteDevice(address); } catch (Exception ignored) { }
        } else {
            // 没给地址：先扫一轮，找到广播本服务的第一个设备就直连
            device = findFirstByScan();
        }
        if (device == null) { call.reject("no watch found"); return; }
        disconnectInternal();
        try {
            gatt = device.connectGatt(getContext(), false, gattCb, BluetoothDevice.TRANSPORT_LE);
            notifyState("connecting");
            call.resolve();
        } catch (Exception e) {
            call.reject("connect failed: " + e.getMessage());
        }
    }

    @SuppressWarnings("MissingPermission")
    private BluetoothDevice findFirstByScan() {
        // 同步等待一轮扫描（BLE 广播 interval 150 slot ≈ 94ms，1.5s 足够）；免回调链的简化。
        final BluetoothDevice[] found = new BluetoothDevice[1];
        try {
            BluetoothLeScanner s = adapter.getBluetoothLeScanner();
            CountDownLatch1 latch = new CountDownLatch1();
            ScanCallback cb = new ScanCallback() {
                @Override
                public void onScanResult(int type, ScanResult r) {
                    if (found[0] == null) found[0] = r.getDevice();
                    latch.countDown();
                }
                @Override public void onScanFailed(int code) { latch.countDown(); }
            };
            s.startScan(Collections.singletonList(
                    new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SVC)).build()), cb);
            latch.await(1500);
            try { s.stopScan(cb); } catch (Exception ignored) { }
        } catch (Exception ignored) { }
        return found[0];
    }

    /** 计划推给手表（今天的训练 JSON）。分片写，等 onCharacteristicWrite 再发下一片。 */
    @PluginMethod
    public void sendPlan(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) { call.reject("json required"); return; }
        if (gatt == null || planChar == null || !subscribed) { call.reject("not connected"); return; }
        String wire = json + "\n";
        byte[] bytes = wire.getBytes(StandardCharsets.UTF_8);
        planQueue.clear();
        int chunk = 20;
        for (int off = 0; off < bytes.length; off += chunk) {
            planQueue.add(slice(bytes, off, Math.min(off + chunk, bytes.length)));
        }
        call.resolve();
        writeNextChunk(gatt);
    }

    private void writeNextChunk(BluetoothGatt g) {
        if (g == null || planQueue.isEmpty()) return;
        byte[] piece = planQueue.remove(0);
        planChar.setValue(piece);
        int prop = planChar.getProperties();
        boolean writeNoRsp = (prop & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                && (prop & BluetoothGattCharacteristic.PROPERTY_WRITE) == 0;
        int type = writeNoRsp ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
        planChar.setWriteType(type);
        boolean ok;
        try {
            ok = g.writeCharacteristic(planChar);
        } catch (Exception e) {
            ok = false;
        }
        if (!ok) planQueue.clear(); // 写失败：丢弃本轮（下次训练开始会重推）
    }

    /**
     * 控制类消息（休息/重量实时同步）：与 sendPlan 同一条分片写路径，但不要求订阅完成——
     * 插件侧不排队，手表不在线时 JS 侧自己决定丢不丢。
     */
    @PluginMethod
    public void sendEvent(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) { call.reject("json required"); return; }
        if (gatt == null || planChar == null) { call.reject("not connected"); return; }
        String wire = json + "\n";
        byte[] bytes = wire.getBytes(StandardCharsets.UTF_8);
        planQueue.clear();
        int chunk = 20;
        for (int off = 0; off < bytes.length; off += chunk) {
            planQueue.add(slice(bytes, off, Math.min(off + chunk, bytes.length)));
        }
        call.resolve();
        writeNextChunk(gatt);
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("connected", gatt != null && subscribed);
        call.resolve(ret);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        disconnectInternal();
        call.resolve();
    }

    private void disconnectInternal() {
        if (gatt != null) {
            try { gatt.disconnect(); gatt.close(); } catch (Exception ignored) { }
        }
        cleanupGatt();
    }

    private void cleanupGatt() {
        gatt = null;
        planChar = null;
        subscribed = false;
        planQueue.clear();
        rx.setLength(0);
    }

    private static byte[] slice(byte[] src, int from, int to) {
        byte[] out = new byte[to - from];
        System.arraycopy(src, from, out, 0, out.length);
        return out;
    }

    /** 极简一次性等待（避免为 1.5s 的扫描引入并发样板）。 */
    private static class CountDownLatch1 {
        private boolean done;
        synchronized void countDown() { done = true; notifyAll(); }
        synchronized void await(long ms) {
            long end = android.os.SystemClock.uptimeMillis() + ms;
            while (!done) {
                long left = end - android.os.SystemClock.uptimeMillis();
                if (left <= 0) return;
                try { wait(left); } catch (InterruptedException e) { return; }
            }
        }
    }
}
