package ch.duartesantos.opengym;

import org.junit.Test;
import java.io.IOException;
import static org.junit.Assert.*;

public class WatchEventChunksTest {
    private static String accept(WatchEventChunks rx, String text, int offset, int end) throws Exception {
        return rx.accept("event", "sid", WatchEventChunks.hash(text), offset, text.length(), text.substring(offset, end), 1000);
    }
    @Test public void reordersAndDeduplicatesWithoutPublishingPartialEvents() throws Exception {
        String text = "{\"t\":\"watch_start\",\"name\":\"中文🏋️\"}";
        WatchEventChunks rx = new WatchEventChunks();
        assertNull(accept(rx, text, 10, text.length()));
        assertNull(accept(rx, text, 10, text.length()));
        assertEquals(text, accept(rx, text, 0, 10));
        assertEquals("4f9f2cab", WatchEventChunks.hash("hello"));
    }
    @Test public void restartRequiresWholeReplayAndOnlyCompleteMessageEntersDurableInbox() throws Exception {
        String text = "{\"t\":\"watch_start\"}";
        WatchEventChunks rx = new WatchEventChunks();
        assertNull(accept(rx, text, 0, 10));
        rx = new WatchEventChunks(); // phone process death: watch still has original durable event
        assertNull(accept(rx, text, 10, text.length()));
        WatchInboxTest.Disk disk = new WatchInboxTest.Disk(); WatchInbox inbox = new WatchInbox(disk);
        disk.fail = true;
        String complete = accept(rx, text, 0, 10);
        try { inbox.put("event", complete); fail(); } catch (IOException expected) { }
        assertEquals(0, inbox.size());
        disk.fail = false;
        assertNull(accept(rx, text, 0, 10));
        inbox.put("event", accept(rx, text, 10, text.length()));
        assertEquals(text, new WatchInbox(disk).batch(1).get("event"));
    }
    @Test public void rejectsCorruptionOverlapAndMismatchedMetadata() throws Exception {
        String text = "abcdefghij"; WatchEventChunks rx = new WatchEventChunks();
        assertNull(accept(rx, text, 0, 5));
        try { accept(rx, text, 4, 8); fail(); } catch (IOException expected) { }
        try { rx.accept("event", "sid", "deadbeef", 5, 10, "fghij", 1000); fail(); } catch (IOException expected) { }
        try { rx.accept("event", "sid", WatchEventChunks.hash(text), 5, 10, "xxxxx", 1000); fail(); } catch (IOException expected) { }
        assertNull(accept(rx, text, 0, 5));
        assertEquals(text, accept(rx, text, 5, 10));
    }
    @Test public void enforcesCapacityAndExpiresAbandonedTransfers() throws Exception {
        WatchEventChunks rx = new WatchEventChunks();
        rx.accept("a", "s", "1", 0, 2, "a", 0); rx.accept("b", "s", "1", 0, 2, "a", 0);
        try { rx.accept("c", "s", "1", 0, 2, "a", 0); fail(); } catch (IOException expected) { }
        assertNull(rx.accept("c", "s", "1", 0, 2, "a", 180001));
        try { rx.accept("x", "s", "1", 0, WatchEventChunks.MAX_BYTES + 1, "a", 180001); fail(); } catch (IOException expected) { }
    }
}
