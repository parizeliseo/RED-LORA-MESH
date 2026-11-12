package ar.pariz.guarani

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** Revisa una cuenta o todas, una detrás de otra (comparten el navegador y las cookies). */
class CheckWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    companion object {
        const val TAG = "guarani-check"
        private val lock = Mutex()
    }

    override suspend fun doWork(): Result {
        val c = applicationContext
        val only = inputData.getString("pid")
        val cuentas = Profiles.all(c).filter { only == null || it.id == only }
        lock.withLock {
            for (prof in cuentas) {
                Store.ensureSeed(c, prof.id)
                try {
                    val r = withTimeout(6 * 60_000L) {
                        withContext(Dispatchers.Main) {
                            Profiles.useSessionOf(c, prof)
                            Scraper(c).run(prof.url, Profiles.user(c, prof.id), Profiles.pass(c, prof.id), Store.watched(c, prof.id))
                        }
                    }
                    Analyzer(c, prof).process(r)
                } catch (e: Throwable) {
                    Store.setStatus(c, prof.id, "${Store.shortNow()} · Error en la revisión: ${e.javaClass.simpleName} ${e.message ?: ""}".trim())
                }
            }
        }
        return Result.success()
    }
}
