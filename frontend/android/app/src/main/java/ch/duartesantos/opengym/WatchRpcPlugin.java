package ch.duartesantos.opengym;

import android.content.pm.PackageManager;

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

    private boolean initialized = false;
    private boolean initInFlight = false;
    private String lastError = null;

    private final IDataReceiver receiver = new IDataReceiver() {
        @Override
        public void onReceiveRequest(Request request) {
            if (request == null) return;
            emit(request.getData(), "request");
            // 手表用 connect.send 发请求时，回一个传输层 ack；业务含义仍由 data 表达。
            try {
                Response response = Util.responseData(request, "{\"code\":0}");
                DeviceRpcManager.getInstance().onResponse(response);
            } catch (Exception ignored) { }
        }

        @Override
        public void onReceiveNotification(Notification notification) {
            if (notification == null) return;
            emit(notification.getData(), "notification");
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
        try { return RpcClient.getInstance().isConnected(TARGET_PACKAGE); }
        catch (Exception e) { return false; }
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
        if (initialized) {
            after.run();
            return;
        }
        if (initInFlight) {
            call.reject("watch RPC is initializing");
            return;
        }
        initInFlight = true;
        lastError = null;
        notifyState("connecting", null);
        try {
            DeviceRpcManager.getInstance().init(getContext(), SDK_KEY, (success, message) -> {
                initInFlight = false;
                initialized = success;
                if (!success) {
                    lastError = message;
                    notifyState("error", message);
                    call.reject(message == null ? "watch RPC init failed" : message);
                    return;
                }
                try {
                    DeviceRpcManager.getInstance().registerDataReceiver(receiver);
                } catch (Exception ignored) { }
                notifyState("ready", null);
                after.run();
            });
        } catch (Exception e) {
            initInFlight = false;
            lastError = e.getMessage();
            notifyState("error", lastError);
            call.reject("watch RPC init failed: " + e.getMessage());
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
                            ret.put("ok", false);
                            ret.put("code", -1);
                            ret.put("data", "");
                            call.resolve(ret);
                            return;
                        }
                        ret.put("ok", response.getCode() == 0);
                        ret.put("code", response.getCode());
                        ret.put("data", response.getData());
                        call.resolve(ret);
                    }
                });
            } catch (Exception e) {
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
            JSObject ret = new JSObject();
            ret.put("connected", isConnectedInternal());
            ret.put("appId", APP_ID);
            ret.put("watchPackage", WATCH_PACKAGE);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        // SDK 没有公开的 unbind；停止业务收发并把状态交回前端即可。
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
                Request request = new Request.Builder()
                        .action(Constant.Action.ACTION_DEVICE_INFO)
                        .pkgName(TARGET_PACKAGE)
                        .data("{}")
                        .timeout(Constant.DEFAULT_TIMEOUT)
                        .build();
                RpcClient.getInstance().callAsync(request, response -> {
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
    public void getVersion(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            ret.put("healthDeviceVersion", DeviceRpcManager.getInstance().getHealthDeviceVersion());
        } catch (Exception e) {
            ret.put("healthDeviceVersion", -1);
        }
        try {
            ret.put("deviceVersion", DeviceRpcManager.getInstance().getDeviceVersion(WATCH_PACKAGE));
        } catch (Exception e) {
            ret.put("deviceVersion", -1);
        }
        ret.put("lastError", lastError == null ? "" : lastError);
        call.resolve(ret);
    }
}
