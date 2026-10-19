package ch.duartesantos.opengym;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.vivo.health.deviceRpcSdk.DeviceRpcManager;
import com.vivo.health.deviceRpcSdk.client.RpcClient;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/** Exercises the actual bundled 1.0.0.17 AAR without binding to Health or a watch. */
@RunWith(AndroidJUnit4.class)
public class WatchRpcInitializationTest {
    private DeviceRpcManager manager;
    private Object core;
    private Field managerContext;
    private Field coreClient;
    private Object savedContext;
    private Object savedClient;

    @Before
    public void isolateSdkSingletons() throws Exception {
        manager = DeviceRpcManager.getInstance();
        managerContext = field(DeviceRpcManager.class, "context");
        Class<?> coreClass = Class.forName("com.vivo.health.deviceRpcSdk.b");
        Method instance = coreClass.getDeclaredMethod("a");
        instance.setAccessible(true);
        core = instance.invoke(null);
        coreClient = field(coreClass, "c");
        savedContext = managerContext.get(manager);
        savedClient = coreClient.get(core);
        managerContext.set(manager, null);
        coreClient.set(core, null);
    }

    @After
    public void restoreSdkSingletons() throws Exception {
        managerContext.set(manager, savedContext);
        coreClient.set(core, savedClient);
    }

    @Test
    public void statusReadBeforeInitDoesNotCreateSdkClient() throws Exception {
        WatchRpcPlugin plugin = new WatchRpcPlugin();
        assertFalse(readConnection(plugin));
        assertFalse(readConnection(plugin));
        assertNull("A status/diagnostics read must not cache a null Context", coreClient.get(core));
    }

    @Test
    public void firstStatusReadAfterContextAssignmentUsesApplicationContext() throws Exception {
        WatchRpcPlugin plugin = new WatchRpcPlugin();
        assertFalse(readConnection(plugin));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext().getApplicationContext();
        // This is the Context assignment made by DeviceRpcManager.init, without its REGISTER I/O.
        managerContext.set(manager, context);
        assertFalse(readConnection(plugin));
        Object client = coreClient.get(core);
        assertNotNull(client);
        assertSame(context, field(client.getClass(), "b").get(client));
    }

    @Test
    public void unguardedSdkStatusReadCachesNullEvenAfterManagerContextChanges() throws Exception {
        // Documents why the bridge must guard this apparently read-only SDK method.
        assertFalse(RpcClient.getInstance().isConnected("com.vivo.health"));
        Object client = coreClient.get(core);
        assertNotNull(client);
        managerContext.set(manager, InstrumentationRegistry.getInstrumentation().getTargetContext());
        assertFalse(RpcClient.getInstance().isConnected("com.vivo.health"));
        assertSame(client, coreClient.get(core));
        assertNull(field(client.getClass(), "b").get(client));
    }

    private static boolean readConnection(WatchRpcPlugin plugin) throws Exception {
        Method method = WatchRpcPlugin.class.getDeclaredMethod("healthServiceConnected");
        method.setAccessible(true);
        return (Boolean) method.invoke(plugin);
    }

    private static Field field(Class<?> type, String name) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }
}
