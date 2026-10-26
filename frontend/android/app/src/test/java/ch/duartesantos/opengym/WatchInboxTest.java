package ch.duartesantos.opengym;
import org.junit.Test;
import static org.junit.Assert.*;
import java.io.IOException;

public class WatchInboxTest {
    static class Disk implements WatchInbox.Store {
        byte[] bytes; boolean fail;
        public byte[] read() { return bytes; }
        public void write(byte[] b) throws IOException { if (fail) throw new IOException("disk full"); bytes = b; }
    }
    @Test public void restartReplaysInOrderAndCompletesOnlyOne() throws Exception {
        Disk disk = new Disk(); WatchInbox a = new WatchInbox(disk);
        a.put("A", "{\"t\":\"set\"}"); a.put("B", "中文".repeat(20000));
        WatchInbox b = new WatchInbox(disk);
        assertEquals(2, b.size()); assertEquals("A", b.batch(1).keySet().iterator().next());
        b.complete("A"); assertEquals(1, new WatchInbox(disk).size());
        assertTrue(new WatchInbox(disk).batch(32).containsKey("B"));
    }
    @Test public void failureNeverPublishesOrDropsAnUncommittedItem() throws Exception {
        Disk disk = new Disk(); WatchInbox a = new WatchInbox(disk); a.put("A", "a");
        disk.fail = true;
        try { a.put("B", "b"); fail(); } catch (IOException expected) { }
        assertEquals(1, a.size());
        try { a.complete("A"); fail(); } catch (IOException expected) { }
        assertTrue(a.batch(32).containsKey("A"));
        assertEquals(1, new WatchInbox(disk).size());
    }
    @Test public void duplicateAndOverflowNeverEvictPendingWork() throws Exception {
        Disk disk = new Disk(); WatchInbox a = new WatchInbox(disk);
        for (int i = 0; i < WatchInbox.MAX_COUNT; i++) a.put("" + i, "a");
        a.put("0", "a");
        try { a.put("0", "different"); fail(); } catch (IOException expected) { }
        try { a.put("overflow", "b"); fail(); } catch (IOException expected) { }
        assertEquals(WatchInbox.MAX_COUNT, new WatchInbox(disk).size());
    }
    @Test public void corruptDiskIsReportedInsteadOfReplacedWithEmptyInbox() throws Exception {
        Disk disk = new Disk(); disk.bytes = new byte[] { 0, 1, 2 };
        try { new WatchInbox(disk); fail(); } catch (IOException expected) { }
        assertArrayEquals(new byte[] { 0, 1, 2 }, disk.bytes);
    }
}
