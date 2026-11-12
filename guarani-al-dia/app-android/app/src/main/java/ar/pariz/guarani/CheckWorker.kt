package ar.pariz.guarani

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

class CheckWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    companion object { const val TAG = "guarani-check" }

    override suspend fun doWork(): Result {
        val c = applicationContext
        Store.ensureSeed(c)
        val base = Config.baseUrl(c)
        return try {
            val r = withTimeout(8 * 60_000L) {
                withContext(Dispatchers.Main) {
                    Scraper(c).run(base, Config.user(c), Config.pass(c), Store.watched(c))
                }
            }
            Analyzer(c).process(r)
            Result.success()
        } catch (e: Throwable) {
            Store.setStatus(c, "Error en la revisión: ${e.javaClass.simpleName} ${e.message ?: ""}".trim())
            Result.success()
        }
    }
}
