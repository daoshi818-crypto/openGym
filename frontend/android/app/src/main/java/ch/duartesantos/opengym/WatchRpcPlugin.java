package ch.duartesantos.opengym;

import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Bundle;
import android.provider.Settings;
import android.util.AtomicFile;

import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
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
import java.util.Map;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

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
    private static final String WATCH_ROUTER = "Index";
    private static final String APP_ID = "106163226";
    private static final String SDK_KEY = "376a3ae868544f4cadaa070ca93b451a";

    private volatile boolean initialized = false;
    private volatile boolean initInFlight = false;
    private volatile boolean sessionActive = false;
    private volatile boolean watchConnected = false;
    private String lastError = null;
    private volatile String lastRxType = "";
    private volatile int lastPlanCode = -1;
    private volatile int lastLaunchCode = -1;
    private final List<String> logs = new ArrayList<>();
    private WatchInbox inbox;
    private String inboxError = "";

    private synchronized WatchInbox inbox() throws IOException {
        if (inbox == null) {
            AtomicFile file = new AtomicFile(new File(getContext().getFilesDir(), "watch-inbox.bin"));
            inbox = new WatchInbox(new WatchInbox.Store() {
                public byte[] read() throws IOException {
                    if (!file.getBaseFile().exists() && !new File(file.getBaseFile() + ".bak").exists()) return null;
                    return file.readFully();
                }
                public void write(byte[] bytes) throws IOException { atomicWrite(file, bytes); }
            });
        }
        return inbox;
    }

    private static void atomicWrite(AtomicFile file, byte[] bytes) throws IOException {
        FileOutputStream stream = null;
        try { stream = file.startWrite(); stream.write(bytes); file.finishWrite(stream); }
        catch (IOException e) { if (stream != null) file.failWrite(stream); throw e; }
    }

    @PluginMethod
    public void checkpointState(PluginCall call) {
        try {
            String json = call.getString("json");
            if (json == null) throw new IOException("state required");
            new JSONObject(json);
            synchronized (this) { atomicWrite(new AtomicFile(new File(getContext().getFilesDir(), "opengym-state.json")), json.getBytes(StandardCharsets.UTF_8)); }
            call.resolve();
        } catch (Exception e) { call.reject("state checkpoint failed", e); }
    }

    @PluginMethod
    public void loadState(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            synchronized (this) { ret.put("json", new String(new AtomicFile(new File(getContext().getFilesDir(), "opengym-state.json")).readFully(), StandardCharsets.UTF_8)); }
            call.resolve(ret);
        } catch (Exception e) { call.reject("state read failed", e); }
    }

    @PluginMethod
    public void drainInbox(PluginCall call) {
        try {
            JSArray events = new JSArray();
            for (Map.Entry<String, String> item : inbox().batch(32).entrySet()) {
                JSONObject ev = new JSONObject(item.getValue()); ev.put("_inboxId", item.getKey()); events.put(ev);
            }
            JSObject ret = new JSObject(); ret.put("events", events); ret.put("pending", inbox().size());
            ret.put("error", inboxError); call.resolve(ret);
        } catch (Exception e) { inboxError = "inbox read failed"; call.reject(inboxError, e); }
    }

    @PluginMethod
    public void completeInbox(PluginCall call) {
        try { inbox().complete(call.getString("id", "")); inboxError = ""; call.resolve(); }
        catch (Exception e) { inboxError = "inbox completion failed"; call.reject(inboxError, e); }
    }

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
            if (request == null) return;
            log("RX request action=" + request.getAction() + " bytes=" + (request.getData() == null ? 0 : request.getData().length()));
            if (Constant.Action.ACTION_DEVICE_DYNAMIC.equals(request.getAction())) {
                if (sessionActive) handleDeviceDynamic(request.getData());
            } else {
                // 收到手表上行数据与“前端是否调用过 connect/send”无关：那只是前端意愿，不是
                // 传输条件。以前这里在 !sessionActive 时静默丢弃整条业务消息，手表的完成组
                // 就永远到不了 JS（手机能下发计划、收不到完成组的形状）。收到的包一律交给
                // JS 决定是否应用；JS 不在或已断开时由手表的 outbox 继续重试。
                if (!sessionActive) log("RX business while inactive: forwarding to JS");
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
            if (notification == null) return;
            log("RX notification action=" + notification.getAction());
            if (Constant.Action.ACTION_DEVICE_DYNAMIC.equals(notification.getAction())) {
                if (sessionActive) handleDeviceDynamic(notification.getData());
            } else {
                if (!sessionActive) log("RX notification while inactive: forwarding to JS");
                emit(notification.getData(), "notification");
            }
        }
    };

    private void emit(String json, String kind) {
        if (json == null || json.isEmpty()) { log("RX business empty"); return; }
        try {
            JSObject data = JSObject.fromJSONObject(new JSONObject(json));
            lastRxType = data.optString("t", "unknown");
            log("RX business " + messageSummary(json));
            String type = data.optString("t", "");
            if (java.util.Arrays.asList("hello", "watch_start", "session_close", "session_close_ack", "pause", "rest", "effort", "weight", "reps", "set", "unset", "add_set", "remove_set", "focus", "end", "summary").contains(type)) {
                try {
                    String identity = data.optString("eventId", "");
                    if (identity.isEmpty()) identity = json;
                    byte[] hash = MessageDigest.getInstance("SHA-256").digest((data.optString("sid", "") + "\n" + identity).getBytes(StandardCharsets.UTF_8));
                    StringBuilder key = new StringBuilder(); for (byte b : hash) key.append(String.format(Locale.US, "%02x", b & 255));
                    inbox().put(key.toString(), json);
                    data.put("_inboxId", key.toString());
                    inboxError = "";
                    if (data.optInt("protocolVersion", 0) >= 3 && !data.optString("eventId", "").isEmpty()) {
                        JSONObject receipt = new JSONObject(); receipt.put("t", "received");
                        receipt.put("eventId", data.optString("eventId")); receipt.put("sid", data.optString("sid"));
                        try {
                            RpcClient.getInstance().callAsync(new Request.Builder().action(Constant.Action.ACTION_DEVICE_BUSINESS_DATA)
                                    .pkgName(TARGET_PACKAGE).data(receipt.toString()).timeout(Constant.DEFAULT_TIMEOUT).build(), new Callback() {
                                @Override public void onResponse(Response response) { }
                            });
                        } catch (Exception ignored) { /* nonterminal receipt; command remains in both logs */ }
                    }
                } catch (Exception e) {
                    inboxError = "inbox persistence failed"; log(inboxError);
                    return; // no terminal business ACK: the watch retains its command
                }
            }
            data.put("_kind", kind);
            notifyListeners("watchEvent", data);
        } catch (Exception e) {
            lastRxType = "raw";
            log("RX business invalid JSON chars=" + json.length());
            JSObject data = new JSObject();
            data.put("t", "raw");
            data.put("data", json);
            data.put("_kind", kind);
            notifyListeners("watchEvent", data);
        }
    }

    private String messageSummary(String json) {
        try {
            JSONObject msg = new JSONObject(json);
            String type = msg.optString("t", "unknown");
            String sid = msg.optString("sid", "");
            return "t=" + type.substring(0, Math.min(32, type.length()))
                    + " sid=" + sid.substring(0, Math.min(64, sid.length()))
                    + " exercises=" + (msg.optJSONArray("exercises") == null ? msg.optInt("exercises", 0) : msg.optJSONArray("exercises").length())
                    + " chars=" + json.length()
                    + summaryField(msg, "planId") + summaryField(msg, "watchVersion")
                    + summaryField(msg, "status") + summaryField(msg, "page")
                    + summaryField(msg, "reason") + summaryField(msg, "decodePath") + summaryField(msg, "error")
                    + ("unknown".equals(type) ? " keys=" + msg.names() : "");
        } catch (Exception e) { return "invalid JSON chars=" + json.length(); }
    }

    private String summaryField(JSONObject msg, String key) {
        String value = msg.optString(key, "");
        return value.isEmpty() ? "" : " " + key + "="
                + value.substring(0, Math.min(160, value.length())).replace('\n', ' ').replace('\r', ' ');
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
        ret.put("bridgeVersion", "2026-10-19.7");
        ret.put("watchPackage", WATCH_PACKAGE);
        ret.put("watchRouter", WATCH_ROUTER);
        ret.put("lastRxType", lastRxType);
        ret.put("lastPlanCode", lastPlanCode);
        ret.put("lastLaunchCode", lastLaunchCode);
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
                String label = plan ? "plan" : "event";
                log("TX " + label + " " + messageSummary(json));
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
                            if (plan) lastPlanCode = -1;
                            log("TX " + label + " response null");
                            ret.put("ok", false);
                            ret.put("code", -1);
                            ret.put("data", "");
                            call.resolve(ret);
                            return;
                        }
                        if (plan) lastPlanCode = response.getCode();
                        log("TX " + label + " response code=" + response.getCode()
                                + " dataChars=" + (response.getData() == null ? 0 : response.getData().length()));
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
    public void openWatchApp(PluginCall call) {
        ensureInit(call, () -> {
            try {
                // SDK 常量与参考应用一致，包名和路由来自本项目手表 manifest。
                JSONObject payload = new JSONObject();
                payload.put("package", WATCH_PACKAGE);
                payload.put("router", WATCH_ROUTER);
                log("LAUNCH package=" + WATCH_PACKAGE + " router=" + WATCH_ROUTER);
                Request request = new Request.Builder()
                        .action(Constant.Action.ACTION_PULL_UP_WATCH)
                        .pkgName(TARGET_PACKAGE)
                        .data(payload.toString())
                        .timeout(Constant.DEFAULT_TIMEOUT)
                        .build();
                RpcClient.getInstance().callAsync(request, response -> {
                    lastLaunchCode = response == null ? -1 : response.getCode();
                    log("LAUNCH response code=" + lastLaunchCode);
                    JSObject ret = new JSObject();
                    ret.put("ok", lastLaunchCode == 0);
                    ret.put("code", lastLaunchCode);
                    ret.put("data", response == null || response.getData() == null ? "" : response.getData());
                    ret.put("watchPackage", WATCH_PACKAGE);
                    ret.put("router", WATCH_ROUTER);
                    call.resolve(ret);
                });
            } catch (Exception e) {
                lastLaunchCode = -1;
                log("LAUNCH failed: " + e.getMessage());
                call.reject("open watch app failed: " + e.getMessage());
            }
        });
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
        try { ret.put("inboxPending", inbox().size()); } catch (Exception e) { inboxError = "inbox read failed"; }
        ret.put("inboxError", inboxError);
        call.resolve(ret);
    }

    @PluginMethod
    public void getVersion(PluginCall call) {
        JSObject ret = environmentDiagnostics();
        try { ret.put("inboxPending", inbox().size()); } catch (Exception e) { inboxError = "inbox read failed"; }
        ret.put("inboxError", inboxError);
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
