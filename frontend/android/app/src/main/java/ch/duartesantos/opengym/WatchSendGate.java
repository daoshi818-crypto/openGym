package ch.duartesantos.opengym;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** One logical SDK request in flight across Native receipts, JS and metadata.
 * SDK timeouts cannot cancel firmware I/O; tokens make late callbacks inert.
 * Payload durability/retry belongs to Inbox/Outbox/transfer owners, not this gate.
 */
final class WatchSendGate<Q, R> {
    interface Timer { Object after(long millis, Runnable action); void cancel(Object token); }
    interface Sender<Q, R> { void send(Q request, Consumer<R> completion); }
    private final Timer timer;
    private final Sender<Q, R> sender;
    private final List<Job> pending = new ArrayList<>();
    private Job active;
    private long generation;
    private int highBurst, mediumBurst;
    private final class Job {
        final Q request; final int priority; final Consumer<R> completion; final long epoch;
        Object timeout; boolean done;
        Job(Q request, int priority, Consumer<R> completion) { this.request=request; this.priority=priority; this.completion=completion; this.epoch=generation; }
    }
    WatchSendGate(Timer timer, Sender<Q, R> sender) { this.timer=timer; this.sender=sender; }
    synchronized boolean offer(Q request, int priority, Consumer<R> completion) {
        if (priority < 0 || priority > 2 || pending.size() >= 128) { completion.accept(null); return false; }
        pending.add(new Job(request, priority, completion)); pump(); return true;
    }
    private void pump() {
        if (active != null || pending.isEmpty()) return;
        int wanted = 0;
        if (highBurst >= 8 && pending.stream().anyMatch(j -> j.priority > 0)) wanted = 1;
        if (mediumBurst >= 16 && pending.stream().anyMatch(j -> j.priority == 2)) wanted = 2;
        Job chosen = null;
        for (Job job : pending) if (job.priority >= wanted && (chosen == null || job.priority < chosen.priority)) chosen = job;
        if (chosen == null) chosen = pending.get(0);
        pending.remove(chosen); active=chosen;
        if (chosen.priority == 0) highBurst++; else highBurst=0;
        if (chosen.priority < 2) mediumBurst++; else mediumBurst=0;
        final Job job = chosen;
        job.timeout=timer.after(6500, () -> finish(job, null));
        try { sender.send(job.request, response -> finish(job, response)); }
        catch (Exception e) { finish(job, null); }
    }
    private synchronized void finish(Job job, R response) {
        if (job.done || active != job || job.epoch != generation) return;
        job.done=true; timer.cancel(job.timeout); active=null;
        try { job.completion.accept(response); } finally { pump(); }
    }
    synchronized void invalidate() {
        generation++;
        List<Job> abandoned = new ArrayList<>(pending); pending.clear();
        if (active != null) { abandoned.add(active); active=null; }
        for (Job job : abandoned) { job.done=true; timer.cancel(job.timeout); job.completion.accept(null); }
    }
}
