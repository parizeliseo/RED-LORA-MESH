package ar.pariz.guarani

import android.content.Context
import android.net.Uri
import org.json.JSONArray

/** Lista de instituciones con SIU Guaraní conocidas (assets/instituciones.json). */
object Instituciones {
    data class Inst(val nombre: String, val url: String) {
        override fun toString() = nombre
    }

    @Volatile private var cache: List<Inst>? = null

    fun all(c: Context): List<Inst> = cache ?: runCatching {
        val a = JSONArray(c.assets.open("instituciones.json").bufferedReader().use { it.readText() })
        (0 until a.length()).map { a.getJSONObject(it) }.map { Inst(it.getString("nombre"), it.getString("url")) }
            .sortedBy { Analyzer.norm(it.nombre) }
    }.getOrDefault(emptyList()).also { cache = it }

    fun nameFor(c: Context, url: String): String? {
        val h = Uri.parse(Profiles.normalizeUrl(url)).host ?: return null
        return all(c).firstOrNull { Uri.parse(it.url).host.equals(h, true) }?.nombre
    }
}
