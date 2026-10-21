package ar.pariz.portal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Avisos del celular para mensajes y alertas que llegan con la app en segundo plano o la pantalla apagada.
 * Un aviso por conversación (se agrupan las últimas líneas); al tocarlo se abre esa conversación.
 */
public class Notifier {
    static final String CH_CANAL = "canal", CH_DM = "directo", CH_ALERTA = "alerta";
    static final Map<String, List<String>> lines = new HashMap<String, List<String>>();
    static boolean ready;

    static void channels(Context c) {
        if (ready || Build.VERSION.SDK_INT < 26) { ready = true; return; }
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel a = new NotificationChannel(CH_CANAL, "Mensajes de canales", NotificationManager.IMPORTANCE_DEFAULT);
        a.setDescription("Mensajes recibidos en los canales de la red");
        NotificationChannel b = new NotificationChannel(CH_DM, "Mensajes directos y favoritos", NotificationManager.IMPORTANCE_HIGH);
        b.setDescription("Mensajes enviados solo a vos y mensajes de nodos favoritos");
        b.enableVibration(true);
        NotificationChannel e = new NotificationChannel(CH_ALERTA, "Alertas de emergencia", NotificationManager.IMPORTANCE_HIGH);
        e.setDescription("Mensajes de pánico / SOS recibidos de la red");
        e.enableVibration(true);
        e.setVibrationPattern(new long[]{0, 800, 300, 800, 300, 800});
        e.enableLights(true);
        e.setBypassDnd(true);
        e.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
            new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        nm.createNotificationChannel(a);
        nm.createNotificationChannel(b);
        nm.createNotificationChannel(e);
        ready = true;
    }

    static int idOf(String conv) { return 1000 + (conv.hashCode() & 0x7ffff); }

    static synchronized void show(Context c, String kind, String conv, String title, String text) {
        channels(c);
        String ch = "alerta".equals(kind) ? CH_ALERTA : ("dm".equals(kind) || "fav".equals(kind)) ? CH_DM : CH_CANAL;
        List<String> l = lines.get(conv);
        if (l == null) { l = new ArrayList<String>(); lines.put(conv, l); }
        l.add(text);
        while (l.size() > 6) l.remove(0);

        Intent open = new Intent(c, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("conv", conv);
        PendingIntent pi = PendingIntent.getActivity(c, idOf(conv), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, ch) : new Notification.Builder(c);
        Notification.InboxStyle st = new Notification.InboxStyle();
        for (String s : l) st.addLine(s);
        if (l.size() > 1) st.setSummaryText(l.size() + " mensajes");
        b.setSmallIcon(R.drawable.ic_stat).setContentTitle(title).setContentText(text).setStyle(st)
            .setAutoCancel(true).setContentIntent(pi).setWhen(System.currentTimeMillis()).setShowWhen(true)
            .setNumber(l.size()).setCategory(CH_ALERTA.equals(ch) ? Notification.CATEGORY_ALARM : Notification.CATEGORY_MESSAGE);
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(CH_CANAL.equals(ch) ? Notification.PRIORITY_DEFAULT : Notification.PRIORITY_HIGH);
            b.setDefaults(Notification.DEFAULT_ALL);
        }
        try {
            ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).notify(idOf(conv), b.build());
        } catch (SecurityException e) { /* sin permiso de avisos */ }
    }

    static synchronized void clear(Context c, String conv) {
        lines.remove(conv);
        try { ((NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE)).cancel(idOf(conv)); } catch (Exception e) {}
    }
}
