package ar.pariz.portal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * Notificación fija mientras la app está abierta: mantiene vivo el proceso para que la conexión con el nodo,
 * MQTT y los avisos sigan funcionando con la pantalla apagada o la app en segundo plano.
 */
public class KeepAliveService extends Service {
    static final String CH = "estado";
    static final String ACTION_EXIT = "ar.pariz.portal.SALIR";
    static volatile String text = "Abierto";
    static volatile KeepAliveService me;
    static volatile boolean location; /* el GPS del celular está en uso: el servicio también es de ubicación */

    static void update(Context c, String t) {
        text = t;
        KeepAliveService s = me;
        if (s != null) {
            NotificationManager nm = (NotificationManager) s.getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 29) { try { s.startForeground(1, s.build(), s.types()); return; } catch (Exception e) {} }
            nm.notify(1, s.build());
            return;
        }
        Intent i = new Intent(c, KeepAliveService.class);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (Exception e) { /* Android no deja iniciarlo desde segundo plano: se intentará al volver */ }
    }

    static void stop(Context c) { try { c.stopService(new Intent(c, KeepAliveService.class)); } catch (Exception e) {} }

    Notification build() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent po = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent exit = new Intent(this, KeepAliveService.class).setAction(ACTION_EXIT);
        PendingIntent pe = PendingIntent.getService(this, 1, exit, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CH) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat).setContentTitle("OPEN SOURCE PARIZ").setContentText(text)
            .setOngoing(true).setContentIntent(po).setShowWhen(false)
            .addAction(new Notification.Action.Builder(null, "Cerrar la app", pe).build());
        return b.build();
    }

    @Override
    public int onStartCommand(Intent i, int flags, int id) {
        if (i != null && ACTION_EXIT.equals(i.getAction())) {
            me = null;
            stopForeground(true);
            stopSelf();
            android.os.Process.killProcess(android.os.Process.myPid());
            return START_NOT_STICKY;
        }
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CH, "Estado de la conexión", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, build(), types());
            else startForeground(1, build());
            me = this;
        } catch (Exception e) { stopSelf(); }
        return START_NOT_STICKY;
    }

    int types() { /* 0x10 = dispositivo conectado; 0x8 = ubicación (solo con el GPS del celular encendido y con permiso) */
        int t = 0x10;
        if (location && checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED) t |= 0x8;
        return t;
    }

    @Override public void onDestroy() { me = null; super.onDestroy(); }
    @Override public IBinder onBind(Intent i) { return null; }
}
