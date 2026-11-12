package ar.pariz.guarani

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** Datos del tablero (mismos conjuntos que la página: resumen, novedades, materias, diplomatura, calendario, mesas) y fotos de cada página. */
object Store {
    val DATASETS = listOf("resumen", "novedades", "materias", "diplomatura", "calendario", "mesas", "menu")
    val TZ: ZoneId = ZoneId.of("America/Buenos_Aires")

    private fun p(c: Context): SharedPreferences = c.getSharedPreferences("store", Context.MODE_PRIVATE)

    fun nowIso(): String = ZonedDateTime.now(TZ).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
    fun today(): String = ZonedDateTime.now(TZ).toLocalDate().toString()

    @Synchronized
    fun ensureSeed(c: Context) {
        if (p(c).getBoolean("seeded", false)) return
        val e = p(c).edit()
        for (n in DATASETS) {
            val txt = runCatching { c.assets.open("seed/$n.json").bufferedReader().use { it.readText() } }.getOrDefault("[]")
            e.putString("ds_$n", txt)
        }
        e.putBoolean("seeded", true).apply()
    }

    fun get(c: Context, n: String): String = p(c).getString("ds_$n", "[]") ?: "[]"
    fun arr(c: Context, n: String): JSONArray = runCatching { JSONArray(get(c, n)) }.getOrDefault(JSONArray())
    fun put(c: Context, n: String, a: JSONArray) { p(c).edit().putString("ds_$n", a.toString()).apply() }

    fun resumen(c: Context): JSONObject {
        val a = arr(c, "resumen")
        return if (a.length() > 0) a.getJSONObject(0) else JSONObject()
    }
    fun putResumen(c: Context, o: JSONObject) = put(c, "resumen", JSONArray().put(o))

    @Synchronized
    fun addNovedad(c: Context, tipo: String, detalle: String) {
        val old = arr(c, "novedades")
        val n = JSONArray()
        n.put(JSONObject().put("fecha", nowIso()).put("tipo", tipo).put("detalle", detalle))
        for (i in 0 until minOf(old.length(), 300)) n.put(old.get(i))
        put(c, "novedades", n)
    }

    // ----- Fotos de páginas -----
    private fun snapDir(c: Context) = File(c.filesDir, "snap").apply { mkdirs() }
    private fun key(url: String): String =
        MessageDigest.getInstance("SHA-1").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }

    fun snapshot(c: Context, url: String): List<String>? {
        val f = File(snapDir(c), key(url))
        return if (f.exists()) f.readLines() else null
    }
    fun setSnapshot(c: Context, url: String, lines: List<String>) { File(snapDir(c), key(url)).writeText(lines.joinToString("\n")) }
    fun clearSnapshots(c: Context) { snapDir(c).listFiles()?.forEach { it.delete() } }

    // ----- Páginas vigiladas -----
    fun watched(c: Context): List<String> =
        (p(c).getString("watched", "") ?: "").lines().map { it.trim() }.filter { it.startsWith("http") }
    fun setWatched(c: Context, l: List<String>) { p(c).edit().putString("watched", l.distinct().joinToString("\n")).apply() }

    // ----- Estado de la última revisión -----
    fun status(c: Context): String = p(c).getString("status", "Todavía no se revisó Guaraní desde la app.") ?: ""
    fun setStatus(c: Context, s: String) { p(c).edit().putString("status", s).apply() }
    fun flag(c: Context, k: String): Boolean = p(c).getBoolean("f_$k", false)
    fun setFlag(c: Context, k: String, v: Boolean) { p(c).edit().putBoolean("f_$k", v).apply() }
}
