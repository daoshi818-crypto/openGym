package ch.duartesantos.opengym;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.*;
import java.util.function.Consumer;

public class WatchSendGateTest {
    static class Clock implements WatchSendGate.Timer {
        final Map<Object,Runnable> tasks = new LinkedHashMap<>();
        public Object after(long ms, Runnable action) { assertEquals(6500, ms); Object key = new Object(); tasks.put(key,action); return key; }
        public void cancel(Object key) { tasks.remove(key); }
        void timeout() { tasks.values().iterator().next().run(); }
    }
    static class Harness {
        final Clock clock = new Clock();
        final List<String> starts = new ArrayList<>();
        final List<Consumer<String>> callbacks = new ArrayList<>();
        final Map<String,List<String>> results = new HashMap<>();
        final WatchSendGate<String,String> gate = new WatchSendGate<>(clock, (req,done) -> { starts.add(req); callbacks.add(done); });
        boolean offer(String id, int priority) { return gate.offer(id,priority,r -> results.computeIfAbsent(id,k -> new ArrayList<>()).add(r)); }
        void done(int index) { callbacks.get(index).accept("ok"); }
    }
    @Test public void serializesAndReevaluatesPriorityAfterEachRequest() {
        Harness h = new Harness(); h.offer("active",2); h.offer("snapshot",2); h.offer("training",1); h.offer("receipt",0);
        assertEquals(Arrays.asList("active"),h.starts); h.done(0); assertEquals("receipt",h.starts.get(1));
        h.done(1); assertEquals("training",h.starts.get(2)); h.done(2); assertEquals("snapshot",h.starts.get(3));
        h.done(3); assertTrue(h.clock.tasks.isEmpty());
    }
    @Test public void makesBusinessAndSnapshotProgressDuringControlFlood() {
        Harness h = new Harness(); h.offer("active",0);
        for (int i=0;i<32;i++) h.offer("control"+i,0);
        h.offer("training",1); h.offer("snapshot",2);
        for (int i=0;i<18;i++) h.done(i);
        assertTrue(h.starts.indexOf("training")<=8); assertTrue(h.starts.indexOf("snapshot")<=16);
    }
    @Test public void timeoutReleasesOnlyLogicalSlotAndIgnoresLateCallback() {
        Harness h = new Harness(); h.offer("a",1); h.offer("b",1); h.clock.timeout();
        assertEquals(Arrays.asList((String)null),h.results.get("a")); assertEquals(Arrays.asList("a","b"),h.starts);
        h.done(0); assertEquals(1,h.results.get("a").size()); assertFalse(h.results.containsKey("b"));
        h.done(1); assertEquals(Arrays.asList("ok"),h.results.get("b"));
    }
    @Test public void invalidationSettlesAllOwnersAndOldGenerationIsInert() {
        Harness h = new Harness(); h.offer("old-active",1); h.offer("old-queued",0); h.gate.invalidate();
        assertEquals(Arrays.asList((String)null),h.results.get("old-active")); assertEquals(Arrays.asList((String)null),h.results.get("old-queued"));
        h.offer("new",1); h.done(0); assertFalse(h.results.containsKey("new")); h.done(1);
        assertEquals(Arrays.asList("ok"),h.results.get("new")); assertTrue(h.clock.tasks.isEmpty());
    }
    @Test public void boundedOverflowReturnsFailureWithoutPretendingBusinessWasDelivered() {
        Harness h = new Harness(); h.offer("active",1);
        for(int i=0;i<128;i++) assertTrue(h.offer("queued"+i,1));
        assertFalse(h.offer("overflow",1)); assertEquals(Arrays.asList((String)null),h.results.get("overflow"));
        assertEquals(1,h.starts.size()); h.gate.invalidate(); assertEquals(130,h.results.size());
    }
    @Test public void thrownSdkCallIsReportedAndDoesNotWedgeGate() {
        Clock clock = new Clock(); List<String> result = new ArrayList<>();
        WatchSendGate<String,String> gate = new WatchSendGate<>(clock,(req,done) -> { throw new IllegalStateException("offline"); });
        gate.offer("a",1,result::add); gate.offer("b",1,result::add);
        assertEquals(Arrays.asList(null,null),result); assertTrue(clock.tasks.isEmpty());
    }
}
