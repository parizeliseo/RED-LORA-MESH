package ar.pariz.guarani

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

object Config {
    const val DEFAULT_URL = "https://siu.iugna.edu.ar/autogestion/"
    val INTERVALS = listOf(15, 30, 60, 120, 360)
    val INTERVAL_LABELS = listOf("15 minutos", "30 minutos", "1 hora", "2 horas", "6 horas")

    private fun p(c: Context) = c.getSharedPreferences("config", Context.MODE_PRIVATE)

    fun baseUrl(c: Context): String = p(c).getString("url", DEFAULT_URL) ?: DEFAULT_URL
    fun interval(c: Context): Int = p(c).getInt("interval", 30)
    fun notifyAll(c: Context): Boolean = p(c).getBoolean("all", true)
    fun wifiOnly(c: Context): Boolean = p(c).getBoolean("wifi", false)
    fun configured(c: Context): Boolean = p(c).getBoolean("configured", false)

    fun save(c: Context, url: String, interval: Int, all: Boolean, wifi: Boolean) {
        var u = url.trim().ifEmpty { DEFAULT_URL }
        if (!u.startsWith("http")) u = "https://$u"
        if (!u.endsWith("/")) u += "/"
        p(c).edit().putString("url", u).putInt("interval", interval).putBoolean("all", all)
            .putBoolean("wifi", wifi).putBoolean("configured", true).apply()
    }

    // ----- Credenciales cifradas -----
    private fun secure(c: Context) = runCatching {
        val key = MasterKey.Builder(c).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            c, "cred", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }.getOrNull()

    fun user(c: Context): String = secure(c)?.getString("u", "") ?: ""
    fun pass(c: Context): String = secure(c)?.getString("p", "") ?: ""
    fun saveCreds(c: Context, u: String, pw: String) {
        secure(c)?.edit()?.putString("u", u.trim())?.putString("p", pw)?.apply()
    }
}
