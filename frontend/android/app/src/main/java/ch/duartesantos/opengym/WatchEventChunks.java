package ch.duartesantos.opengym;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.TreeMap;

/** Bounded transient assembly. The watch keeps its durable event until business commit;
 * after phone process death it resends the entire event, never just missing fragments.
 * Only the complete, checksum-verified JSON enters the existing durable Inbox. */
final class WatchEventChunks {
    static final int MAX_BYTES = 131072;
    private static final long TTL = 180000;
    private static final class Job {
        final String hash; final int total; final long at;
        final TreeMap<Integer, String> parts = new TreeMap<>();
        int chars;
        Job(String hash, int total, long at) { this.hash = hash; this.total = total; this.at = at; }
    }
    private final Map<String, Job> jobs = new HashMap<>();

    static String hash(String text) {
        int h = 0x811c9dc5;
        for (int i = 0; i < text.length(); i++) h = (h ^ text.charAt(i)) * 16777619;
        return Integer.toHexString(h);
    }

    synchronized String accept(String eventId, String sid, String hash, int offset, int total, String data, long now) throws IOException {
        Iterator<Job> expired = jobs.values().iterator();
        while (expired.hasNext()) if (now - expired.next().at > TTL) expired.remove();
        if (eventId == null || eventId.isEmpty() || eventId.length() > 256 || sid == null || sid.isEmpty() || sid.length() > 256 ||
            hash == null || !hash.matches("[0-9a-f]{1,8}") || total < 1 || total > MAX_BYTES || offset < 0 ||
            data == null || data.isEmpty() || data.length() > 1000 || offset > total - data.length()) throw new IOException("invalid event fragment");
        String key = eventId.length() + ":" + eventId + sid;
        Job job = jobs.get(key);
        if (job == null) {
            if (jobs.size() >= 2) throw new IOException("event transfer capacity");
            job = new Job(hash, total, now); jobs.put(key, job);
        }
        if (!job.hash.equals(hash) || job.total != total) throw new IOException("event transfer mismatch");
        String prior = job.parts.get(offset);
        if (prior != null) {
            if (!prior.equals(data)) throw new IOException("event fragment mismatch");
        } else {
            if (job.parts.size() >= 512) throw new IOException("event fragment capacity");
            Map.Entry<Integer, String> before = job.parts.floorEntry(offset), after = job.parts.ceilingEntry(offset);
            if ((before != null && before.getKey() + before.getValue().length() > offset) || (after != null && offset + data.length() > after.getKey()))
                throw new IOException("overlapping event fragments");
            job.parts.put(offset, data); job.chars += data.length();
        }
        if (job.chars != job.total) return null;
        StringBuilder text = new StringBuilder(job.total);
        for (Map.Entry<Integer, String> part : job.parts.entrySet()) {
            if (part.getKey() != text.length()) throw new IOException("event fragment gap");
            text.append(part.getValue());
        }
        jobs.remove(key);
        String result = text.toString();
        if (result.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES || !hash(result).equals(job.hash)) throw new IOException("event checksum");
        return result;
    }
}
