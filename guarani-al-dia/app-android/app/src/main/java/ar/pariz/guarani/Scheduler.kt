package ar.pariz.guarani

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

object Scheduler {
    private const val PERIODIC = "guarani-periodico"
    private const val NOW = "guarani-ahora"

    private fun constraints(c: Context) = Constraints.Builder()
        .setRequiredNetworkType(if (Config.wifiOnly(c)) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .build()

    fun schedule(c: Context, replace: Boolean) {
        if (!Config.configured(c)) return
        val req = PeriodicWorkRequestBuilder<CheckWorker>(Config.interval(c).toLong(), TimeUnit.MINUTES)
            .setConstraints(constraints(c))
            .addTag(CheckWorker.TAG)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(
            PERIODIC,
            if (replace) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
            req
        )
    }

    fun checkNow(c: Context) {
        val req = OneTimeWorkRequestBuilder<CheckWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .addTag(CheckWorker.TAG)
            .build()
        WorkManager.getInstance(c).enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, req)
    }
}
