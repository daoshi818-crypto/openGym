package ch.duartesantos.opengym;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Ordered durable inbox. A failed write never changes the visible map; no pending eviction. */
final class WatchInbox {
    interface Store { byte[] read() throws IOException; void write(byte[] bytes) throws IOException; }
    static final int MAX_COUNT = 512, MAX_BYTES = 2 * 1024 * 1024, MAX_MESSAGE = 131072;
    private final Store store;
    private LinkedHashMap<String, String> pending = new LinkedHashMap<>();
    WatchInbox(Store store) throws IOException {
        this.store = store;
        byte[] bytes = store.read();
        if (bytes == null || bytes.length == 0) return;
        if (bytes.length > MAX_BYTES) throw new IOException("inbox exceeds byte limit");
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (in.readInt() != 1) throw new IOException("unknown inbox version");
            int count = in.readInt();
            if (count < 0 || count > MAX_COUNT) throw new IOException("invalid inbox count");
            for (int i = 0; i < count; i++) pending.put(readText(in), readText(in));
            if (in.available() != 0) throw new IOException("trailing inbox bytes");
        }
    }
    private static String readText(DataInputStream in) throws IOException {
        int size = in.readInt();
        if (size < 0 || size > MAX_MESSAGE) throw new IOException("invalid inbox item");
        byte[] bytes = new byte[size]; in.readFully(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }
    private static void writeText(DataOutputStream out, String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_MESSAGE) throw new IOException("message too large");
        out.writeInt(bytes.length); out.write(bytes);
    }
    private void commit(LinkedHashMap<String, String> next) throws IOException {
        if (next.size() > MAX_COUNT) throw new IOException("inbox full");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream out = new DataOutputStream(bytes)) {
            out.writeInt(1); out.writeInt(next.size());
            for (Map.Entry<String, String> item : next.entrySet()) { writeText(out, item.getKey()); writeText(out, item.getValue()); }
        }
        if (bytes.size() > MAX_BYTES) throw new IOException("inbox full");
        store.write(bytes.toByteArray());
        pending = next;
    }
    synchronized void put(String id, String json) throws IOException {
        if (pending.containsKey(id)) {
            if (!pending.get(id).equals(json)) throw new IOException("event identity reused");
            return;
        }
        LinkedHashMap<String, String> next = new LinkedHashMap<>(pending);
        next.put(id, json); commit(next);
    }
    synchronized void complete(String id) throws IOException {
        if (!pending.containsKey(id)) return;
        LinkedHashMap<String, String> next = new LinkedHashMap<>(pending);
        next.remove(id); commit(next);
    }
    synchronized Map<String, String> batch(int limit) {
        LinkedHashMap<String, String> batch = new LinkedHashMap<>();
        for (Map.Entry<String, String> item : pending.entrySet()) {
            if (batch.size() >= limit) break;
            batch.put(item.getKey(), item.getValue());
        }
        return batch;
    }
    synchronized int size() { return pending.size(); }
}
