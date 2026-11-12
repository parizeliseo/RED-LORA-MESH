package ar.pariz.guarani

import android.content.Context
import android.net.Uri
import android.webkit.CookieManager
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Una cuenta de SIU Guaraní: una institución (o facultad) y un usuario. */
data class Profile(
    val id: String,
    val nombre: String,
    val institucion: String,
    val url: String,
    val savePass: Boolean
) {
    val host: String get() = Uri.parse(url).host ?: ""
    fun json(): JSONObject = JSONObject().put("id", id).put("nombre", nombre).put("institucion", institucion)
        .put("url", url).put("savePass", savePass)
    companion object {
        fun from(o: JSONObject) = Profile(o.getString("id"), o.optString("nombre"), o.optString("institucion"),
            o.optString("url"), o.optBoolean("savePass", true))
    }
}

object Profiles {
    private fun p(c: Context) = c.getSharedPreferences("profiles", Context.MODE_PRIVATE)

    /** Usuario y contraseña van cifrados con una clave del Android Keystore, nunca en texto plano. */
    private fun secure(c: Context) = runCatching {
        val key = MasterKey.Builder(c).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(c, "cred", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    }.getOrNull()

    fun normalizeUrl(url: String): String {
        var u = url.trim()
        if (u.isEmpty()) return u
        if (!u.startsWith("http")) u = "https://$u"
        // Si pegaron la dirección del formulario de ingreso, quedarse con la base.
        u = u.substringBefore('#').substringBefore('?')
        u = u.replace(Regex("/acceso(/.*)?$"), "/")
        if (!u.endsWith("/")) u += "/"
        return u
    }

    @Synchronized
    fun all(c: Context): List<Profile> {
        migrate(c)
        val a = runCatching { JSONArray(p(c).getString("list", "[]")) }.getOrDefault(JSONArray())
        return (0 until a.length()).map { Profile.from(a.getJSONObject(it)) }
    }

    fun get(c: Context, id: String?): Profile? = all(c).firstOrNull { it.id == id }

    fun active(c: Context): Profile? {
        val l = all(c)
        return l.firstOrNull { it.id == p(c).getString("active", null) } ?: l.firstOrNull()
    }

    fun setActive(c: Context, id: String) { p(c).edit().putString("active", id).apply() }

    @Synchronized
    fun save(c: Context, prof: Profile, user: String?, pass: String?) {
        val l = all(c).toMutableList()
        val i = l.indexOfFirst { it.id == prof.id }
        if (i >= 0) l[i] = prof else l.add(prof)
        p(c).edit().putString("list", JSONArray(l.map { it.json() }).toString()).apply()
        val s = secure(c)?.edit() ?: return
        if (user != null) s.putString("u_${prof.id}", user.trim())
        if (!prof.savePass) s.remove("p_${prof.id}") else if (pass != null) s.putString("p_${prof.id}", pass)
        s.apply()
        Store.ensureSeed(c, prof.id)
    }

    @Synchronized
    fun delete(c: Context, id: String) {
        val l = all(c).filter { it.id != id }
        p(c).edit().putString("list", JSONArray(l.map { it.json() }).toString()).apply()
        secure(c)?.edit()?.remove("u_$id")?.remove("p_$id")?.apply()
        Store.deleteAll(c, id)
        if (p(c).getString("active", null) == id) l.firstOrNull()?.let { setActive(c, it.id) }
    }

    fun user(c: Context, id: String): String = secure(c)?.getString("u_$id", "") ?: ""
    fun pass(c: Context, id: String): String {
        val prof = get(c, id) ?: return ""
        return if (prof.savePass) secure(c)?.getString("p_$id", "") ?: "" else ""
    }
    fun savePassword(c: Context, id: String, user: String, pass: String) {
        val prof = get(c, id) ?: return
        save(c, prof.copy(savePass = true), user, pass)
    }

    fun newId(): String = "c" + UUID.randomUUID().toString().take(8)

    // ----- Sesiones: dos cuentas del mismo Guaraní no pueden estar abiertas a la vez -----
    /** Deja las cookies del sitio listas para [prof]: si eran de otra cuenta del mismo sitio, las borra. */
    fun useSessionOf(c: Context, prof: Profile): Boolean {
        val key = "owner_${prof.host}"
        val owner = p(c).getString(key, null)
        var cleared = false
        if (owner != null && owner != prof.id && all(c).any { it.id == owner && it.host == prof.host }) {
            clearCookies(prof.url); cleared = true
        }
        p(c).edit().putString(key, prof.id).apply()
        return cleared
    }

    fun clearCookies(url: String) {
        val cm = CookieManager.getInstance()
        val raw = cm.getCookie(url) ?: return
        val path = Uri.parse(url).path?.trimEnd('/')?.ifEmpty { "/" } ?: "/"
        raw.split(";").map { it.substringBefore('=').trim() }.filter { it.isNotEmpty() }.forEach { name ->
            for (pth in setOf("/", path)) cm.setCookie(url, "$name=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=$pth")
        }
        cm.flush()
    }

    /** Pasa la cuenta única de las versiones 1.0/1.1 a la primera cuenta. */
    private var migrated = false
    private fun migrate(c: Context) {
        if (migrated) return
        migrated = true
        if (p(c).contains("list")) return
        val url = Config.legacyUrl(c) ?: run { p(c).edit().putString("list", "[]").apply(); return }
        val s = secure(c)
        val u = s?.getString("u", "") ?: ""
        val pw = s?.getString("p", "") ?: ""
        val id = "c1"
        val host = Uri.parse(url).host ?: url
        val inst = Instituciones.nameFor(c, url) ?: host
        val prof = Profile(id, inst, inst, normalizeUrl(url), true)
        p(c).edit().putString("list", JSONArray().put(prof.json()).toString()).putString("active", id).apply()
        s?.edit()?.putString("u_$id", u)?.putString("p_$id", pw)?.remove("u")?.remove("p")?.apply()
        Store.migrateLegacy(c, id)
        Store.ensureSeed(c, id)
        Config.clearLegacy(c)
    }
}
