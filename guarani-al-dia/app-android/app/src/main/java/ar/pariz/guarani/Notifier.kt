package ar.pariz.guarani

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

object Notifier {
    const val CH_NOTAS = "notas"
    const val CH_CAMBIOS = "cambios"
    const val CH_ESTADO = "estado"
    const val CH_INSC = "inscripciones"
    private const val GROUP = "guarani"

    fun createChannels(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_NOTAS, "Notas y actas", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Cuando se carga o cambia una nota, una promoción o un acta"
            enableVibration(true)
        })
        nm.createNotificationChannel(NotificationChannel(CH_INSC, "Inscripciones, períodos y vencimientos", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Apertura y cierre de inscripciones, mesas de examen y vencimientos de finales"
        })
        nm.createNotificationChannel(NotificationChannel(CH_CAMBIOS, "Otros cambios en Guaraní", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Mensajes, inscripciones, mesas, calendario y cualquier otro cambio"
        })
        nm.createNotificationChannel(NotificationChannel(CH_ESTADO, "Estado de la sesión", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Avisos cuando la sesión de Guaraní vence"
        })
    }

    fun notify(c: Context, channel: String, title: String, text: String, lines: List<String> = emptyList(), tab: String = "dash") {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val id = (System.currentTimeMillis() % Int.MAX_VALUE).toInt() xor title.hashCode()
        val intent = Intent(c, MainActivity::class.java).putExtra("tab", tab)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(c, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val big = if (lines.isEmpty()) text else lines.take(8).joinToString("\n")
        val b = NotificationCompat.Builder(c, channel)
            .setSmallIcon(R.drawable.ic_notif)
            .setColor(0xFF1F5C4A.toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(big))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setGroup(GROUP)
            .setPriority(if (channel == CH_NOTAS) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
        runCatching { NotificationManagerCompat.from(c).notify(id, b.build()) }
    }
}
