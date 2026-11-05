package ch.duartesantos.opengym;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;

/** Local-only, bounded PNG extraction. No arbitrary paths, URLs, videos or user media. */
@CapacitorPlugin(name = "WatchMedia")
public class WatchMediaPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private static final int PX = 180, MAX_FRAMES = 96, MAX_BYTES = 4 * 1024 * 1024;
    private File home() throws IOException {
        File f = new File(getContext().getCacheDir(), "watch-png-v1");
        if (!f.isDirectory() && !f.mkdirs()) throw new IOException("cache_unavailable");
        return f;
    }
    private static String hash(byte[] bytes) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder s = new StringBuilder();
        for (byte b : d) s.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return s.toString();
    }
    private static byte[] bytes(File f) throws IOException {
        if (f.length() > MAX_BYTES) throw new IOException("file_too_large");
        try (InputStream in = new FileInputStream(f); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[4096]; int n;
            while ((n = in.read(b)) != -1) { out.write(b, 0, n); if (out.size() > MAX_BYTES) throw new IOException("file_too_large"); }
            return out.toByteArray();
        }
    }
    private static void remove(File dir) {
        File[] children = dir.listFiles();
        if (children != null) for (File f : children) { if (f.isDirectory()) remove(f); else f.delete(); }
        dir.delete();
    }
    private void prune(File keep) throws IOException {
        File[] dirs = home().listFiles(File::isDirectory);
        if (dirs == null) return;
        Arrays.sort(dirs, (a,b) -> Long.compare(b.lastModified(), a.lastModified()));
        int n = 0;
        for (File d : dirs) if (!d.equals(keep) && ++n > 2) remove(d);
    }
    @PluginMethod public void prepare(PluginCall call) {
        String source = call.getString("sourceId", "");
        if (!source.matches("[A-Za-z0-9_-]{1,32}")) { call.reject("invalid_source"); return; }
        worker.execute(() -> {
            MediaMetadataRetriever retriever = new MediaMetadataRetriever();
            File dir = null;
            try {
                String path = "public/exercise-media/clip/" + source + ".mp4";
                byte[] clip;
                try (InputStream in = getContext().getAssets().open(path); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] b = new byte[4096]; int n;
                    while ((n = in.read(b)) != -1) { out.write(b,0,n); if (out.size() > 8*1024*1024) throw new IOException("source_too_large"); }
                    clip = out.toByteArray();
                }
                String key = hash(("png-v1-180-12fps:" + source + ":" + hash(clip)).getBytes(StandardCharsets.UTF_8));
                dir = new File(home(), key); File ready = new File(dir, "ready.json");
                if (ready.isFile()) {
                    try {
                        JSObject cached = new JSObject(new String(bytes(ready), StandardCharsets.UTF_8));
                        JSONArray frames = cached.getJSONArray("frames");
                        boolean valid = frames.length() >= 2 && frames.length() <= MAX_FRAMES;
                        for (int i=0; valid && i<frames.length(); i++) {
                            byte[] data = bytes(new File(dir,i+".png"));
                            valid = data.length == frames.getJSONObject(i).getInt("bytes")
                                    && hash(data).equals(frames.getJSONObject(i).getString("sha256"));
                        }
                        if (valid) { dir.setLastModified(System.currentTimeMillis()); call.resolve(cached); return; }
                    } catch (Exception ignored) { /* Corrupt/partial cache is rebuilt, not returned forever. */ }
                }
                remove(dir); if (!dir.mkdirs()) throw new IOException("cache_unavailable");
                // Using a bounded private copy also works if Android compresses the source asset.
                File input = new File(dir,"source.mp4");
                try (OutputStream out = new FileOutputStream(input)) { out.write(clip); }
                retriever.setDataSource(input.getAbsolutePath());
                long duration = Long.parseLong(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION));
                if (duration < 100 || duration > 35000) throw new IOException("unsupported_duration");
                int count = Math.max(2, Math.min(MAX_FRAMES, (int)Math.ceil(duration * 12.0 / 1000)));
                int total = 0; JSArray frames = new JSArray();
                for (int i=0; i<count; i++) {
                    long time = i * duration * 1000 / count;
                    Bitmap raw = Build.VERSION.SDK_INT >= 27
                            ? retriever.getScaledFrameAtTime(time, MediaMetadataRetriever.OPTION_CLOSEST, PX, PX)
                            : retriever.getFrameAtTime(time, MediaMetadataRetriever.OPTION_CLOSEST);
                    if (raw == null) throw new IOException("decode_failed");
                    Bitmap square = Bitmap.createBitmap(PX,PX,Bitmap.Config.ARGB_8888);
                    Canvas canvas = new Canvas(square); canvas.drawColor(Color.WHITE);
                    float scale = Math.min((float)PX/raw.getWidth(), (float)PX/raw.getHeight());
                    float w=raw.getWidth()*scale, h=raw.getHeight()*scale;
                    canvas.drawBitmap(raw,null,new RectF((PX-w)/2,(PX-h)/2,(PX+w)/2,(PX+h)/2),new Paint(Paint.FILTER_BITMAP_FLAG));
                    raw.recycle();
                    ByteArrayOutputStream png = new ByteArrayOutputStream();
                    try { if (!square.compress(Bitmap.CompressFormat.PNG,100,png)) throw new IOException("encode_failed"); }
                    finally { square.recycle(); }
                    byte[] data=png.toByteArray(); total += data.length;
                    if (data.length > 65536 || total > MAX_BYTES) throw new IOException("media_too_large");
                    try (OutputStream out = new FileOutputStream(new File(dir,i+".png"))) { out.write(data); }
                    JSObject frame = new JSObject(); frame.put("bytes",data.length); frame.put("sha256",hash(data));
                    frame.put("duration",(int)(((i+1)*duration/count)-(i*duration/count))); frames.put(frame);
                }
                input.delete();
                JSObject manifest = new JSObject();
                manifest.put("assetKey",key); manifest.put("sourceId",source); manifest.put("width",PX); manifest.put("height",PX);
                manifest.put("count",count); manifest.put("durationMs",duration); manifest.put("totalBytes",total); manifest.put("frames",frames);
                try (OutputStream out = new FileOutputStream(ready)) { out.write(manifest.toString().getBytes(StandardCharsets.UTF_8)); }
                dir.setLastModified(System.currentTimeMillis()); prune(dir); call.resolve(manifest);
            } catch (Exception e) {
                if (dir != null && !new File(dir,"ready.json").isFile()) remove(dir);
                call.reject("media_prepare_failed: " + e.getClass().getSimpleName());
            } finally { try { retriever.release(); } catch (Exception ignored) {} }
        });
    }
    @PluginMethod public void readChunk(PluginCall call) {
        String key=call.getString("assetKey",""); int frame=call.getInt("frame",-1), offset=call.getInt("offset",-1);
        if (!key.matches("[a-f0-9]{64}") || frame<0 || frame>=MAX_FRAMES || offset<0 || offset>65536) { call.reject("invalid_chunk"); return; }
        worker.execute(() -> {
            try {
                File dir=new File(home(),key); if (!new File(dir,"ready.json").isFile()) throw new IOException("not_ready");
                byte[] data=bytes(new File(dir,frame+".png")); if (offset>=data.length) throw new IOException("invalid_offset");
                int end=Math.min(data.length,offset+2048);
                JSObject result=new JSObject(); result.put("data",Base64.encodeToString(Arrays.copyOfRange(data,offset,end),Base64.NO_WRAP));
                result.put("length",end-offset); call.resolve(result);
            } catch (Exception e) { call.reject("media_read_failed"); }
        });
    }
    @Override protected void handleOnDestroy() { worker.shutdownNow(); }
}
