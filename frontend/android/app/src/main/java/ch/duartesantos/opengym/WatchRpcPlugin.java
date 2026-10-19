package ch.duartesantos.opengym;

import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Bundle;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.vivo.health.deviceRpcSdk.Constant;
import com.vivo.health.deviceRpcSdk.DeviceRpcManager;
import com.vivo.health.deviceRpcSdk.client.Callback;
import com.vivo.health.deviceRpcSdk.client.RpcClient;
import com.vivo.health.deviceRpcSdk.data.Notification;
import com.vivo.health.deviceRpcSdk.data.Request;
import com.vivo.health.deviceRpcSdk.data.Response;
import com.vivo.health.deviceRpcSdk.service.IDataReceiver;
import com.vivo.health.deviceRpcSdk.util.Util;

import org.json.JSONObject;

import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * vivo 智能终端设备 SDK 的 Capacitor 桥。
 *
 * 手机侧只负责把业务 JSON 送给健康应用/手表，并接收手表发来的 JSON。
 * 发现、连接、组网、鉴权都由 SDK 完成，不需要扫描或选择设备。
 */
@CapacitorPlugin(name = "WatchRpc")
public class WatchRpcPlugin extends Plugin {
    private static final String TARGET_PACKAGE = "com.vivo.health";
    private static final String WATCH_PACKAGE = "com.zcode.gymtimer";
    private static final String APP_ID = "106163226";
    private static final String SDK_KEY = "376a3ae868544f4cadaa070ca93b451a";

    private volatile boolean initialized = false;
    private volatile boolean initInFlight = false;
    private volatile boolean sessionActive = false;
    private volatile boolean watchConnected = false;
    private String lastError = null;
    private final List<String> logs = new ArrayList<>();

    private void log(String message) {
        String line = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date()) + "  " + message;
        synchronized (logs) {
            logs.add(line);
            while (logs.size() > 300) logs.remove(0);
        }
        android.util.Log.i("WatchRpc", line);
        JSObject data = new JSObject();
        data.put("line", line);
        notifyListeners("watchLog", data);
    }

    private final IDataReceiver receiver = new IDataReceiver() {
        @Override
        public void onReceiveRequest(Request request) {
            if (request == null || !sessionActive) return;
            log("RX request action=" + request.getAction() + " bytes=" + (request.getData() == null ? 0 : request.getData().length()));
            if (Constant.Action.ACTION_DEVICE_DYNAMIC.equals(request.getAction())) {
                handleDeviceDynamic(request.getData());
            } else {
                emit(request.getData(), "request");
            }
            // 手表用 connect.send 发请求时，回一个传输层 ack；业务含义仍由 data 表达。
            try {
                Response response = Util.responseData(request, "{\"code\":0}");
                DeviceRpcManager.getInstance().onResponse(response);
            } catch (Exception e) {
                log("RX response failed: " + e.getMessage());
            }
        }

        @Override
        public void onReceiveNotification(Notification notification) {
            if (notification == null || !sessionActive) return;
            log("RX notification action=" + notification.getAction());
            if (Constant.Action.ACTION_DEVICE_DYNAMIC.equals(notification.getAction())) {
                handleDeviceDynamic(notification.getData());
            } else {
                emit(notification.getData(), "notification");
            }
        }
    };

    private void emit(String json, String kind) {
        if (json == null || json.isEmpty()) return;
        try {
            JSObject data = JSObject.fromJSONObject(new JSONObject(json));
            data.put("_kind", kind);
            notifyListeners("watchEvent", data);
        } catch (Exception e) {
            JSObject data = new JSObject();
            data.put("t", "raw");
            data.put("data", json);
            data.put("_kind", kind);
            notifyListeners("watchEvent", data);
        }
    }

    private void notifyState(String state, String reason) {
        JSObject data = new JSObject();
        data.put("state", state);
        if (reason != null) data.put("reason", reason);
        data.put("connected", isConnectedInternal());
        notifyListeners("watchState", data);
    }

    private boolean isConnectedInternal() {
        return sessionActive && initialized && watchConnected && healthServiceConnected();
    }

    private boolean healthServiceConnected() {
        try {
            // 1.0.0.17 的 isConnected 会创建并缓存 client；init 前调用会永久缓存 null Context。
            if (!sdkContextReady()) return false;
            return RpcClient.getInstance().isConnected(TARGET_PACKAGE);
        }
        catch (Exception e) { return false; }
    }

    private boolean sdkContextReady() {
        return DeviceRpcManager.getInstance().getContext() != null;
    }

    private void handleDeviceDynamic(String data) {
        // SDK 自身的动态通知只表示 Android 服务绑定，不表示手表在线。
        if ((TARGET_PACKAGE + ":false").equals(data)) {
            watchConnected = false;
            if (initialized) notifyState("ready", null);
        } else if ((TARGET_PACKAGE + ":true").equals(data)) {
            if (initialized) requestDeviceInfo(response -> { });
        } else {
            updateDeviceInfo(data);
        }
    }

    private void updateDeviceInfo(String data) {
        if (!sessionActive || data == null) return;
        try {
            JSONObject device = new JSONObject(data).optJSONObject("device");
            if (device == null) return;
            if (device.has("connected")) {
                boolean connected = device.getBoolean("connected");
                boolean changed = watchConnected != connected;
                watchConnected = connected;
                if (initialized && changed) notifyState(connected ? "connected" : "ready", null);
            }
            JSObject event = JSObject.fromJSONObject(device);
            event.put("t", "device");
            notifyListeners("watchEvent", event);
        } catch (Exception e) {
            log("device info parse failed: " + e.getMessage());
        }
    }

    private void requestDeviceInfo(Callback callback) {
        Request request = new Request.Builder()
                .action(Constant.Action.ACTION_DEVICE_INFO)
                .pkgName(TARGET_PACKAGE)
                .data("{}")
                .timeout(Constant.DEFAULT_TIMEOUT)
                .build();
        RpcClient.getInstance().callAsync(request, response -> {
            log("DEVICE_INFO code=" + (response == null ? -1 : response.getCode()));
            if (response != null && response.getCode() == 0) {
                updateDeviceInfo(response.getData());
            } else if (watchConnected) {
                watchConnected = false;
                if (sessionActive) notifyState("ready", null);
            }
            callback.onResponse(response);
        });
    }

    private boolean healthInstalled() {
        try {
            getContext().getPackageManager().getPackageInfo(TARGET_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private void ensureInit(PluginCall call, Runnable after) {
        sessionActive = true;
        if (initialized) {
            log("already initialized");
            after.run();
            return;
        }
        if (initInFlight) {
            call.reject("watch RPC is initializing");
            return;
        }
        initInFlight = true;
        lastError = null;
        log("init start: vivo=" + safeIsVivo() + ", healthInstalled=" + healthInstalled());
        log("environment=" + environmentDiagnostics());
        log("app signature sha256=" + appSignatureSha256());
        logMeta();
        notifyState("connecting", null);
        try {
            // 4 参 init 的第一个 String 是健康应用包名，第二个是 SDK 密钥。
            DeviceRpcManager.getInstance().init(getContext().getApplicationContext(), TARGET_PACKAGE, SDK_KEY, (success, message) -> {
                if (success) {
                    finishInit(call, after, "4-arg");
                    return;
                }
                // 此 AAR 的四参方法直接委托三参，重复调用不会改变绑定/授权条件。
                failInit(call, message);
            });
        } catch (Exception e) {
            failInit(call, e.getMessage());
        }
    }

    private void finishInit(PluginCall call, Runnable after, String how) {
        try {
            DeviceRpcManager.getInstance().registerDataReceiver(receiver);
            log("receiver registered");
        } catch (Exception e) {
            failInit(call, "receiver register failed: " + e.getMessage());
            return;
        }
        initInFlight = false;
        initialized = true;
        lastError = null;
        log("init success via " + how);
        notifyState("ready", null);
        after.run();
    }

    private void failInit(PluginCall call, String message) {
        initInFlight = false;
        initialized = false;
        watchConnected = false;
        lastError = message == null || message.isEmpty()
                ? "SDK init failed without detail; check environment and REGISTER code (8: health RPC unavailable; 9: permission denied)"
                : message;
        log("init failed: " + lastError);
        notifyState("error", lastError);
        probeRegistration();
        call.reject(lastError);
    }

    private boolean safeIsVivo() {
        try { return Util.isVivoPhone(); } catch (Exception e) { return false; }
    }

    private JSObject environmentDiagnostics() {
        JSObject ret = new JSObject();
        ret.put("bridgeVersion", "2026-10-19.2");
        ret.put("sdkContextReady", sdkContextReady());
        ret.put("phonePackage", getContext().getPackageName());
        ret.put("watchTargetPackageMatches", "ch.duartesantos.opengym".equals(getContext().getPackageName()));
        ret.put("vivo", safeIsVivo());
        try { ret.put("vos", Util.isVos()); } catch (Exception | LinkageError e) { ret.put("vos", "unknown"); }
        try { ret.put("startBind", DeviceRpcManager.getInstance().isStartBind()); } catch (Exception e) { ret.put("startBind", "unknown"); }
        ret.put("healthInstalled", healthInstalled());
        ret.put("healthDeviceVersion", -1);
        ret.put("healthEnabled", false);
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(TARGET_PACKAGE, PackageManager.GET_META_DATA);
            ret.put("healthVersion", pi.versionName);
            ret.put("healthVersionCode", pi.versionCode);
            ApplicationInfo ai = pi.applicationInfo;
            ret.put("healthEnabled", ai != null && ai.enabled);
            ret.put("healthDeviceVersion", ai == null || ai.metaData == null ? 0
                    : ai.metaData.getInt("health.device.manager.version", 0));
        } catch (Exception e) { ret.put("healthReadError", e.toString()); }
        ret.put("rpcServicePresent", false);
        ComponentName rpcComponent = new ComponentName(TARGET_PACKAGE,
                "com.vivo.health.deviceRpcSdk.service.DeviceRpcService");
        try {
            ServiceInfo service = getContext().getPackageManager().getServiceInfo(
                    rpcComponent,
                    PackageManager.MATCH_DISABLED_COMPONENTS);
            ret.put("rpcServicePresent", true);
            ret.put("rpcServiceEnabled", service.enabled);
            ret.put("rpcServiceExported", service.exported);
            ret.put("rpcServicePermission", service.permission == null ? "" : service.permission);
        } catch (Exception e) { ret.put("rpcServiceReadError", e.toString()); }
        try {
            // enabled 字段之外，再观察运行时组件覆盖值及 SDK 的实际 Intent 能否解析。
            PackageManager pm = getContext().getPackageManager();
            ret.put("rpcServiceComponentState", pm.getComponentEnabledSetting(rpcComponent));
            Intent rpcIntent = new Intent("com.vivo.health.device.rpc.channel").setComponent(rpcComponent);
            ret.put("rpcServiceResolvable", pm.resolveService(rpcIntent, 0) != null);
        } catch (Exception e) { ret.put("rpcServiceResolveError", e.toString()); }
        try {
            // 仅观察 SDK 的绑定前置条件；不修改系统设置或 start_bind。
            ret.put("boundWatchDeviceCount", Settings.Global.getInt(getContext().getContentResolver(),
                    "com.vivo.health.watch.boundWatchDeviceCount", 0));
        } catch (Exception e) {
            ret.put("boundWatchDeviceCount", -1);
            ret.put("boundWatchReadError", e.toString());
        }
        ret.put("healthServiceConnected", healthServiceConnected());
        ret.put("watchConnected", isConnectedInternal());
        return ret;
    }

    private String appSignatureSha256() {
        try {
            PackageInfo pi = getContext().getPackageManager()
                    .getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNATURES);
            if (pi.signatures == null || pi.signatures.length == 0) return "none";
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(pi.signatures[0].toByteArray());
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) sb.append(String.format(Locale.US, "%02X", b));
            return sb.toString();
        } catch (Exception e) {
            return "err:" + e.getMessage();
        }
    }

    private void logMeta() {
        try {
            ApplicationInfo ai = getContext().getPackageManager()
                    .getApplicationInfo(getContext().getPackageName(), PackageManager.GET_META_DATA);
            Bundle b = ai.metaData;
            Object a1 = b == null ? null : b.get("vivo.health.rpc.appid");
            Object a2 = b == null ? null : b.get("appid");
            log("meta vivo.health.rpc.appid=" + a1 + " (" + (a1 == null ? "null" : a1.getClass().getSimpleName()) + ")"
                    + ", appid=" + a2 + " (" + (a2 == null ? "null" : a2.getClass().getSimpleName()) + ")");
        } catch (Exception e) {
            log("meta read failed: " + e.getMessage());
        }
    }

    private void probeRegistration() {
        // init 若在写入 Context 前抛出异常，探测同样不能提前创建 SDK client。
        if (!sdkContextReady()) {
            log("REGISTER probe skipped: SDK Context unavailable");
            return;
        }
        try {
            JSONObject json = new JSONObject();
            json.put("appid", APP_ID);
            json.put("appname", getContext().getPackageName());
            // 与项目内 device-rpc 1.0.0.17 的 checkThirdPermission 保持一致。
            json.put("encryVersion", 0);
            json.put("encryStr", SDK_KEY);
            Request req = new Request.Builder()
                    .action(Constant.Action.ACTION_THIRD_REGIST)
                    .pkgName(TARGET_PACKAGE)
                    .data(json.toString())
                    .timeout(Constant.DEFAULT_TIMEOUT)
                    .build();
            log("REGISTER probe send");
            RpcClient.getInstance().callAsync(req, response -> {
                if (response == null) {
                    log("REGISTER probe response null");
                    return;
                }
                log("REGISTER probe code=" + response.getCode()
                        + " (0=ok, 8=health RPC unavailable, 9=permission denied)");
            });
        } catch (Exception e) {
            log("REGISTER probe failed: " + e.getMessage());
        }
    }

    private void send(PluginCall call, boolean plan) {
        String json = call.getString("json");
        if (json == null || json.isEmpty()) {
            call.reject("json required");
            return;
        }
        ensureInit(call, () -> {
            try {
                log("TX " + (plan ? "plan" : "event") + " bytes=" + json.length());
                Request request = new Request.Builder()
                        .action(Constant.Action.ACTION_DEVICE_BUSINESS_DATA)
                        .pkgName(TARGET_PACKAGE)
                        .data(json)
                        .timeout(Constant.DEFAULT_TIMEOUT)
                        .build();
                RpcClient.getInstance().callAsync(request, new Callback() {
                    @Override
                    public void onResponse(Response response) {
                        JSObject ret = new JSObject();
                        if (response == null) {
                            log("TX response null");
                            ret.put("ok", false);
                            ret.put("code", -1);
                            ret.put("data", "");
                            call.resolve(ret);
                            return;
                        }
                        log("TX response code=" + response.getCode() + " data=" + response.getData());
                        ret.put("ok", response.getCode() == 0);
                        ret.put("code", response.getCode());
                        ret.put("data", response.getData());
                        call.resolve(ret);
                    }
                });
            } catch (Exception e) {
                log("TX failed: " + e.getMessage());
                call.reject((plan ? "send plan failed: " : "send event failed: ") + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        boolean vivo = false;
        try { vivo = Util.isVivoPhone(); } catch (Exception ignored) { }
        boolean health = healthInstalled();
        ret.put("available", vivo && health);
        ret.put("vivo", vivo);
        ret.put("healthInstalled", health);
        ret.put("connected", isConnectedInternal());
        ret.put("reason", !vivo ? "notVivo" : (!health ? "healthMissing" : ""));
        call.resolve(ret);
    }

    @PluginMethod
    public void connect(PluginCall call) {
        ensureInit(call, () -> {
            try {
                requestDeviceInfo(response -> {
                    JSObject ret = new JSObject();
                    ret.put("connected", isConnectedInternal());
                    ret.put("healthServiceConnected", healthServiceConnected());
                    ret.put("appId", APP_ID);
                    ret.put("watchPackage", WATCH_PACKAGE);
                    call.resolve(ret);
                });
            } catch (Exception e) { call.reject("get device info failed: " + e.getMessage()); }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        // SDK 没有公开的 unbind；停止业务收发并把状态交回前端即可。
        sessionActive = false;
        watchConnected = false;
        notifyState("off", null);
        call.resolve();
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("connected", isConnectedInternal());
        call.resolve(ret);
    }

    @PluginMethod
    public void sendPlan(PluginCall call) {
        send(call, true);
    }

    @PluginMethod
    public void sendEvent(PluginCall call) {
        send(call, false);
    }

    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        ensureInit(call, () -> {
            try {
                requestDeviceInfo(response -> {
                    JSObject ret = new JSObject();
                    ret.put("ok", response != null && response.getCode() == 0);
                    ret.put("code", response == null ? -1 : response.getCode());
                    String data = response == null ? null : response.getData();
                    ret.put("data", data == null ? "" : data);
                    call.resolve(ret);
                });
            } catch (Exception e) {
                call.reject("get device info failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getLogs(PluginCall call) {
        StringBuilder sb = new StringBuilder();
        synchronized (logs) {
            for (String line : logs) sb.append(line).append('\n');
        }
        JSObject ret = new JSObject();
        ret.put("logs", sb.toString());
        ret.put("lastError", lastError == null ? "" : lastError);
        ret.put("initialized", initialized);
        call.resolve(ret);
    }

    @PluginMethod
    public void getVersion(PluginCall call) {
        JSObject ret = environmentDiagnostics();
        ret.put("initialized", initialized);
        ret.put("appSignature", appSignatureSha256());
        try {
            ret.put("permissionStatus", DeviceRpcManager.getInstance().getPermissionStatus());
            ret.put("startBind", DeviceRpcManager.getInstance().isStartBind());
            ret.put("originPkg", DeviceRpcManager.getInstance().getOriginPkgName());
        } catch (Exception e) {
            ret.put("permissionStatus", false);
            ret.put("startBind", false);
            ret.put("originPkg", "");
        }
        try {
            ret.put("healthPkg", DeviceRpcManager.getHealthPackageName());
        } catch (Exception e) {
            ret.put("healthPkg", "");
        }
        ret.put("lastError", lastError == null ? "" : lastError);
        call.resolve(ret);
    }
}
