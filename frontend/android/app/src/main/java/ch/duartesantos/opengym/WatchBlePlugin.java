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
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;
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

    private static final int MTU = 185;
    private static final int CHUNK = 20;
    private static final long SCAN_TIMEOUT_MS = 6000L;
    private static final long GATT_TIMEOUT_MS = 15000L;

    private BluetoothAdapter adapter; // 懒初始化：Plugin 的 context 在 load() 里还拿不到

    private BluetoothAdapter adapter() {
        if (adapter == null) {
            Context c = getContext();
            if (c != null) {
                BluetoothManager mgr = (BluetoothManager) c.getApplicationContext().getSystemService(Context.BLUETOOTH_SERVICE);
                adapter = mgr == null ? null : mgr.getAdapter();
            }
        }
        return adapter;
    }

    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic planChar;
    private BluetoothGattCharacteristic eventChar;
    private BluetoothGattCharacteristic statusChar;
    private BluetoothGattDescriptor notifyDescriptor;
    private PluginCall pendingConnectCall;
    private boolean scanning;
    private boolean subscribed;
    private boolean notificationPending;
    private final ByteArrayOutputStream rx = new ByteArrayOutputStream();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Deque<WriteRequest> writeQueue = new ArrayDeque<>();
    private WriteRequest activeWrite;
    private ScanCallback activeScanCallback;
    private Runnable scanTimeoutTask;
    private Runnable gattTimeoutTask;

    private static final class WriteRequest {
        final BluetoothGattCharacteristic characteristic;
        final byte[] bytes;
        final PluginCall call;
        final String label;
        int offset;
        int inFlightSize;

        WriteRequest(BluetoothGattCharacteristic characteristic, byte[] bytes, PluginCall call, String label) {
            this.characteristic = characteristic;
            this.bytes = bytes;
            this.call = call;
            this.label = label;
        }
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

    @PermissionCallback
    private void onPermResult(PluginCall call) {
        if (call == null) return;
        BluetoothAdapter a = adapter();
        boolean bluetoothOn = a != null && a.isEnabled();
        call.resolve(new JSObject()
                .put("granted", bluetoothOn && hasPerms())
                .put("bluetoothOn", bluetoothOn)
                .put("permission", hasPerms()));
    }

    /** 蓝牙可用且权限齐全？granted=false 时 JS 引导用户去开蓝牙/授权。 */
    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        BluetoothAdapter a = adapter();
        boolean hw = a != null && a.isEnabled();
        ret.put("granted", hw && hasPerms());
        ret.put("bluetoothOn", hw);
        ret.put("permission", hasPerms());
        call.resolve(ret);
    }

    /** 运行时申请权限（Android 12+）；已授权直接返回 true。 */
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        BluetoothAdapter a = adapter();
        if (a == null || !a.isEnabled()) {
            call.resolve(new JSObject().put("granted", false).put("bluetoothOn", false));
            return;
        }
        if (hasPerms()) {
            call.resolve(new JSObject().put("granted", true));
            return;
        }
        String alias = Build.VERSION.SDK_INT >= 31 ? "watchBle" : "watchBleLegacy";
        requestPermissionForAlias(alias, call, "onPermResult");
    }

    // ---- 扫描：手动配对列出所有可连接的 BLE 广播 ----

    private final ScanCallback scanCb = new ScanCallback() {
        @Override
        public void onScanResult(int type, ScanResult r) {
            if (!scanning) return;
            // Manual pairing deliberately scans without a Service UUID filter. Some watch
            // firmware puts the UUID in a scan response or omits it from the first packet,
            // which would otherwise make a real device invisible. Only expose connectable
            // advertisements; the serviceMatch flag lets the UI put our watch first.
            boolean connectable = Build.VERSION.SDK_INT < Build.VERSION_CODES.O || r.isConnectable();
            if (!connectable) return;
            JSObject data = new JSObject();
            ScanRecord record = r.getScanRecord();
            if (hasPerms()) {
                String name = safeName(r.getDevice());
                if ((name == null || name.isEmpty()) && record != null) name = record.getDeviceName();
                data.put("name", name);
                data.put("address", safeAddress(r.getDevice()));
            }
            boolean serviceMatch = false;
            if (record != null && record.getServiceUuids() != null) {
                for (ParcelUuid uuid : record.getServiceUuids()) {
                    if (uuid != null && SVC.equals(uuid.getUuid())) {
                        serviceMatch = true;
                        break;
                    }
                }
            }
            data.put("found", true);
            data.put("connectable", true);
            data.put("serviceMatch", serviceMatch);
            data.put("rssi", r.getRssi());
            notifyListeners("deviceFound", data);
        }

        @Override
        public void onScanFailed(int code) {
            stopScan();
            notifyListeners("scanFailed", new JSObject().put("code", code));
        }
    };

    private final ScanCallback connectScanCb = new ScanCallback() {
        @Override
        public void onScanResult(int type, ScanResult r) {
            if (!scanning || activeScanCallback != this) return;
            PluginCall call = pendingConnectCall;
            pendingConnectCall = null;
            stopScan();
            beginGattConnect(r.getDevice(), call);
        }

        @Override
        public void onScanFailed(int code) {
            if (activeScanCallback != this) return;
            PluginCall call = pendingConnectCall;
            pendingConnectCall = null;
            stopScan();
            rejectConnect(call, "scan failed: " + code);
        }
    };

    private String safeName(BluetoothDevice d) {
        try { return d.getName(); } catch (SecurityException e) { return null; }
    }

    @PluginMethod
    public void startScan(PluginCall call) {
        if (!hasPerms()) { call.reject("permission missing"); return; }
        BluetoothAdapter a = adapter();
        if (a == null || !a.isEnabled() || a.getBluetoothLeScanner() == null) {
            call.reject("bluetooth off");
            return;
        }
        if (scanning) { call.resolve(); return; }
        try {
            scanner = a.getBluetoothLeScanner();
            // Manual pairing shows every connectable BLE advertisement. The user can select
            // the watch even when its service UUID is only present after the scan response.
            List<ScanFilter> filters = Collections.emptyList();
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
            scanning = true;
            activeScanCallback = scanCb;
            scanner.startScan(filters, settings, scanCb);
            scanTimeoutTask = () -> {
                if (!scanning || activeScanCallback != scanCb) return;
                stopScan();
                notifyListeners("scanFinished", new JSObject().put("reason", "timeout"));
            };
            mainHandler.postDelayed(scanTimeoutTask, SCAN_TIMEOUT_MS);
            call.resolve();
        } catch (Exception e) {
            scanning = false;
            activeScanCallback = null;
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
            try {
                if (activeScanCallback != null) scanner.stopScan(activeScanCallback);
            } catch (Exception ignored) { }
        }
        scanning = false;
        activeScanCallback = null;
        if (scanTimeoutTask != null) {
            mainHandler.removeCallbacks(scanTimeoutTask);
            scanTimeoutTask = null;
        }
    }

    private void startConnectScan(PluginCall call) {
        if (scanning) {
            call.reject("scan already in progress");
            return;
        }
        BluetoothAdapter a = adapter();
        BluetoothLeScanner s = a == null ? null : a.getBluetoothLeScanner();
        if (s == null) {
            rejectConnect(call, "bluetooth scanner unavailable");
            return;
        }
        try {
            scanner = s;
            List<ScanFilter> filters = Collections.singletonList(
                    new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SVC)).build());
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
            pendingConnectCall = call;
            activeScanCallback = connectScanCb;
            scanning = true;
            notifyState("scanning");
            s.startScan(filters, settings, connectScanCb);
            scanTimeoutTask = () -> {
                if (!scanning || activeScanCallback != connectScanCb) return;
                PluginCall pending = pendingConnectCall;
                pendingConnectCall = null;
                stopScan();
                rejectConnect(pending, "no watch found");
            };
            mainHandler.postDelayed(scanTimeoutTask, SCAN_TIMEOUT_MS);
        } catch (Exception e) {
            pendingConnectCall = null;
            stopScan();
            rejectConnect(call, "scan failed: " + e.getMessage());
        }
    }

    // ---- 连接与 GATT ----

    private final BluetoothGattCallback gattCb = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (g != gatt) return;
            if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                notifyState("connected");
                boolean requested = false;
                try { requested = g.requestMtu(MTU); } catch (Exception ignored) { }
                if (!requested) discoverServices(g);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                notifyState("disconnected");
                cleanupGatt();
            } else if (newState != BluetoothProfile.STATE_CONNECTED) {
                failGatt("connection failed: " + status);
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            if (g == gatt) discoverServices(g);
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            if (g != gatt) return;
            if (status != BluetoothGatt.GATT_SUCCESS) {
                failGatt("service discovery failed: " + status);
                return;
            }
            BluetoothGattService svc = g.getService(SVC);
            if (svc == null) {
                failGatt("service not found");
                return;
            }
            planChar = svc.getCharacteristic(C_PLAN);
            eventChar = svc.getCharacteristic(C_EVENT);
            statusChar = svc.getCharacteristic(C_STATUS);
            if (planChar == null || eventChar == null || statusChar == null) {
                failGatt("required characteristic missing");
                return;
            }
            if (!enableNotify(g, eventChar)) failGatt("notification setup failed");
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            if (g == gatt && C_EVENT.equals(c.getUuid())) feedEvent(value);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            if (g != gatt || d != notifyDescriptor) return;
            notificationPending = false;
            if (status != BluetoothGatt.GATT_SUCCESS) {
                failGatt("notification descriptor failed: " + status);
                return;
            }
            subscribed = true;
            cancelGattTimeout();
            notifyState("ready");
            if (statusChar != null) {
                try { g.readCharacteristic(statusChar); } catch (Exception ignored) { }
            }
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (g != gatt || status != BluetoothGatt.GATT_SUCCESS || !C_STATUS.equals(c.getUuid())) return;
            handleStatusRead(c.getValue());
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (g == gatt && activeWrite != null && c == activeWrite.characteristic) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    failWrites(activeWrite.label + " write failed: " + status);
                } else {
                    activeWrite.offset = Math.min(activeWrite.bytes.length, activeWrite.offset + activeWrite.inFlightSize);
                    writeNextChunk(g);
                }
            }
        }
    };

    @SuppressWarnings("MissingPermission")
    private boolean enableNotify(BluetoothGatt g, BluetoothGattCharacteristic c) {
        if (!g.setCharacteristicNotification(c, true)) return false;
        BluetoothGattDescriptor d = c.getDescriptor(CCCD);
        if (d == null) return false;
        d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        notifyDescriptor = d;
        notificationPending = true;
        try {
            return g.writeDescriptor(d);
        } catch (Exception e) {
            notificationPending = false;
            return false;
        }
    }

    private void notifyState(String state) {
        notifyState(state, null);
    }

    private void notifyState(String state, String reason) {
        JSObject data = new JSObject();
        data.put("state", state);
        if (gatt != null && hasPerms()) data.put("name", safeName(gatt.getDevice()));
        if (gatt != null && hasPerms()) {
            try { data.put("address", gatt.getDevice().getAddress()); } catch (SecurityException ignored) { }
        }
        if (reason != null) data.put("reason", reason);
        notifyListeners("watchState", data);
    }

    /** 完成特征值的字节流重组：\n 定界一条 JSON（与手表端 ble.js 同一规则）。 */
    private void feedEvent(byte[] chunk) {
        if (chunk == null) return;
        for (byte b : chunk) {
            if (b == '\n') {
                emitLine(new String(rx.toByteArray(), StandardCharsets.UTF_8));
                rx.reset();
            } else {
                if (rx.size() >= 8192) rx.reset();
                rx.write(b);
            }
        }
    }

    private void emitLine(String line) {
        line = line.trim();
        if (line.isEmpty()) return;
        try {
            org.json.JSONObject raw = new org.json.JSONObject(line);
            JSObject msg = JSObject.fromJSONObject(raw);
            notifyListeners("watchEvent", msg);
            if (raw.has("at") && !raw.isNull("at")) acknowledge(raw.optLong("at", Long.MIN_VALUE));
        } catch (Exception ignored) { /* 半包/坏包丢弃 */ }
    }

    private void handleStatusRead(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return;
        try {
            org.json.JSONObject raw = new org.json.JSONObject(new String(bytes, StandardCharsets.UTF_8).trim());
            notifyListeners("watchHello", JSObject.fromJSONObject(raw));
        } catch (Exception ignored) { }
    }

    // ---- JS API：连接 / 推计划 / 断开 ----

    @PluginMethod
    public void connect(PluginCall call) {
        if (!hasPerms()) { call.reject("permission missing"); return; }
        BluetoothAdapter a = adapter();
        if (a == null || !a.isEnabled()) { call.reject("bluetooth off"); return; }
        String address = call.getString("address");
        BluetoothDevice device = null;
        if (address != null && !address.isEmpty()) {
            try { device = a.getRemoteDevice(address); } catch (Exception ignored) { }
        } else {
            disconnectInternal();
            startConnectScan(call);
            return;
        }
        if (device == null) { call.reject("no watch found"); return; }
        disconnectInternal();
        beginGattConnect(device, call);
    }

    @SuppressWarnings("MissingPermission")
    private void beginGattConnect(BluetoothDevice device, PluginCall call) {
        if (device == null) {
            rejectConnect(call, "no watch found");
            return;
        }
        try {
            notifyState("connecting");
            gatt = device.connectGatt(getContext(), false, gattCb, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null) {
                rejectConnect(call, "connect failed");
                return;
            }
            if (call != null) call.resolve(new JSObject().put("address", safeAddress(device)));
            scheduleGattTimeout();
        } catch (Exception e) {
            rejectConnect(call, "connect failed: " + e.getMessage());
        }
    }

    private String safeAddress(BluetoothDevice device) {
        try { return device == null ? null : device.getAddress(); } catch (SecurityException e) { return null; }
    }

    private void rejectConnect(PluginCall call, String reason) {
        notifyState("error", reason);
        if (call != null) call.reject(reason);
    }

    private void discoverServices(BluetoothGatt g) {
        if (g != gatt) return;
        try {
            if (!g.discoverServices()) failGatt("service discovery rejected");
        } catch (Exception e) {
            failGatt("service discovery failed: " + e.getMessage());
        }
    }

    private void scheduleGattTimeout() {
        cancelGattTimeout();
        gattTimeoutTask = () -> {
            if (gatt != null && !subscribed) failGatt("connection timeout");
        };
        mainHandler.postDelayed(gattTimeoutTask, GATT_TIMEOUT_MS);
    }

    private void cancelGattTimeout() {
        if (gattTimeoutTask != null) {
            mainHandler.removeCallbacks(gattTimeoutTask);
            gattTimeoutTask = null;
        }
    }

    private void failGatt(String reason) {
        notifyState("error", reason);
        BluetoothGatt old = gatt;
        cleanupGatt();
        if (old != null) {
            try { old.disconnect(); old.close(); } catch (Exception ignored) { }
        }
    }

    /** 计划推给手表（今天的训练 JSON）。所有写入都串行等待 GATT 回调。 */
    @PluginMethod
    public void sendPlan(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) { call.reject("json required"); return; }
        if (gatt == null || planChar == null || !subscribed) { call.reject("not connected"); return; }
        enqueueWrite(planChar, (json + "\n").getBytes(StandardCharsets.UTF_8), call, "plan");
    }

    private void writeNextChunk(BluetoothGatt g) {
        if (g == null || g != gatt) return;
        if (activeWrite == null) activeWrite = writeQueue.pollFirst();
        if (activeWrite == null) return;
        if (activeWrite.offset >= activeWrite.bytes.length) {
            finishActiveWrite();
            return;
        }

        int end = Math.min(activeWrite.bytes.length, activeWrite.offset + CHUNK);
        byte[] piece = slice(activeWrite.bytes, activeWrite.offset, end);
        BluetoothGattCharacteristic characteristic = activeWrite.characteristic;
        characteristic.setValue(piece);
        int prop = characteristic.getProperties();
        boolean writeNoRsp = (prop & BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0
                && (prop & BluetoothGattCharacteristic.PROPERTY_WRITE) == 0;
        int type = writeNoRsp ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
        characteristic.setWriteType(type);
        activeWrite.inFlightSize = end - activeWrite.offset;
        boolean ok;
        try {
            ok = g.writeCharacteristic(characteristic);
        } catch (Exception e) {
            ok = false;
        }
        if (!ok) {
            failWrites(activeWrite.label + " write rejected");
        } else if (writeNoRsp) {
            activeWrite.offset = end;
            mainHandler.post(() -> writeNextChunk(g));
        }
    }

    /**
     * 控制类消息（休息/重量实时同步）：与计划共享同一条串行写路径，避免覆盖计划分片。
     */
    @PluginMethod
    public void sendEvent(PluginCall call) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) { call.reject("json required"); return; }
        if (gatt == null || planChar == null || !subscribed) { call.reject("not connected"); return; }
        enqueueWrite(planChar, (json + "\n").getBytes(StandardCharsets.UTF_8), call, "event");
    }

    private void enqueueWrite(BluetoothGattCharacteristic characteristic, byte[] bytes, PluginCall call, String label) {
        if (gatt == null || characteristic == null || !subscribed) {
            if (call != null) call.reject("not connected");
            return;
        }
        writeQueue.addLast(new WriteRequest(characteristic, bytes, call, label));
        writeNextChunk(gatt);
    }

    private void finishActiveWrite() {
        WriteRequest done = activeWrite;
        activeWrite = null;
        if (done != null && done.call != null) done.call.resolve();
        writeNextChunk(gatt);
    }

    private void failWrites(String reason) {
        rejectWrites(reason);
        notifyState("error", reason);
        subscribed = false;
    }

    private void rejectWrites(String reason) {
        if (activeWrite != null && activeWrite.call != null) activeWrite.call.reject(reason);
        activeWrite = null;
        while (!writeQueue.isEmpty()) {
            WriteRequest pending = writeQueue.removeFirst();
            if (pending.call != null) pending.call.reject(reason);
        }
    }

    private void acknowledge(long upto) {
        if (upto == Long.MIN_VALUE || gatt == null || statusChar == null || !subscribed) return;
        try {
            org.json.JSONObject ack = new org.json.JSONObject();
            ack.put("t", "ack");
            ack.put("upto", upto);
            enqueueWrite(statusChar, (ack.toString() + "\n").getBytes(StandardCharsets.UTF_8), null, "ack");
        } catch (Exception ignored) { }
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
        stopScan();
        if (pendingConnectCall != null) {
            pendingConnectCall.reject("disconnected");
            pendingConnectCall = null;
        }
        cancelGattTimeout();
        rejectWrites("disconnected");
        BluetoothGatt old = gatt;
        gatt = null;
        if (old != null) {
            try { old.disconnect(); old.close(); } catch (Exception ignored) { }
        }
        clearGattState();
    }

    private void cleanupGatt() {
        cancelGattTimeout();
        rejectWrites("disconnected");
        clearGattState();
    }

    private void clearGattState() {
        gatt = null;
        planChar = null;
        eventChar = null;
        statusChar = null;
        notifyDescriptor = null;
        subscribed = false;
        notificationPending = false;
        rx.reset();
    }

    private static byte[] slice(byte[] src, int from, int to) {
        byte[] out = new byte[to - from];
        System.arraycopy(src, from, out, 0, out.length);
        return out;
    }

}
