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

/**
 * Datos de cada cuenta (resumen, novedades, materias, otra propuesta, calendario, mesas y menús)
 * y fotos de cada página. Todo va separado por cuenta: el parámetro [pid] es el id de la cuenta.
 */
object Store {
    val DATASETS = listOf("resumen", "novedades", "materias", "diplomatura", "calendario", "mesas", "menu", "menu_publico")
    val TZ: ZoneId = ZoneId.of("America/Buenos_Aires")

    private fun p(c: Context): SharedPreferences = c.getSharedPreferences("store", Context.MODE_PRIVATE)

    fun nowIso(): String = ZonedDateTime.now(TZ).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)
    fun today(): String = ZonedDateTime.now(TZ).toLocalDate().toString()
    fun shortNow(): String = ZonedDateTime.now(TZ).format(DateTimeFormatter.ofPattern("dd/MM HH:mm"))

    /** Primera carga de una cuenta nueva: datos vacíos. */
    @Synchronized
    fun ensureSeed(c: Context, pid: String) {
        if (p(c).getBoolean("seeded_$pid", false)) return
        val e = p(c).edit()
        for (n in DATASETS) {
            val txt = runCatching { c.assets.open("seed/$n.json").bufferedReader().use { it.readText() } }.getOrDefault("[]")
            e.putString("ds_${pid}_$n", txt)
        }
        e.putBoolean("seeded_$pid", true).apply()
    }

    /** Pasa los datos de la versión de una sola cuenta (1.0 / 1.1) a la cuenta [pid]. */
    @Synchronized
    fun migrateLegacy(c: Context, pid: String) {
        val sp = p(c)
        if (!sp.getBoolean("seeded", false)) return
        val e = sp.edit()
        for (n in DATASETS) sp.getString("ds_$n", null)?.let { e.putString("ds_${pid}_$n", it); e.remove("ds_$n") }
        sp.getString("watched", null)?.let { e.putString("watched_$pid", it); e.remove("watched") }
        sp.getString("status", null)?.let { e.putString("status_$pid", it); e.remove("status") }
        for (k in listOf("session_warned", "baseline_done")) if (sp.contains("f_$k")) {
            e.putBoolean("f_${pid}_$k", sp.getBoolean("f_$k", false)); e.remove("f_$k")
        }
        e.putBoolean("f_${pid}_first_ok", true)
        e.putBoolean("seeded_$pid", true).remove("seeded").apply()
        val old = File(c.filesDir, "snap")
        val dest = snapDir(c, pid)
        old.listFiles()?.filter { it.isFile }?.forEach { it.renameTo(File(dest, it.name)) }
    }

    fun get(c: Context, pid: String, n: String): String = p(c).getString("ds_${pid}_$n", "[]") ?: "[]"
    fun arr(c: Context, pid: String, n: String): JSONArray = runCatching { JSONArray(get(c, pid, n)) }.getOrDefault(JSONArray())
    fun put(c: Context, pid: String, n: String, a: JSONArray) { p(c).edit().putString("ds_${pid}_$n", a.toString()).apply() }

    fun resumen(c: Context, pid: String): JSONObject {
        val a = arr(c, pid, "resumen")
        return if (a.length() > 0) a.getJSONObject(0) else JSONObject()
    }
    fun putResumen(c: Context, pid: String, o: JSONObject) = put(c, pid, "resumen", JSONArray().put(o))

    @Synchronized
    fun addNovedad(c: Context, pid: String, tipo: String, detalle: String) {
        val old = arr(c, pid, "novedades")
        val n = JSONArray()
        n.put(JSONObject().put("fecha", nowIso()).put("tipo", tipo).put("detalle", detalle))
        for (i in 0 until minOf(old.length(), 300)) n.put(old.get(i))
        put(c, pid, "novedades", n)
    }

    // ----- Fotos de páginas -----
    private fun snapDir(c: Context, pid: String) = File(c.filesDir, "snap/$pid").apply { mkdirs() }
    private fun key(url: String): String =
        MessageDigest.getInstance("SHA-1").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }

    fun snapshot(c: Context, pid: String, url: String): List<String>? {
        val f = File(snapDir(c, pid), key(url))
        return if (f.exists()) f.readLines() else null
    }
    fun setSnapshot(c: Context, pid: String, url: String, lines: List<String>) { File(snapDir(c, pid), key(url)).writeText(lines.joinToString("\n")) }
    fun clearSnapshots(c: Context, pid: String) { snapDir(c, pid).listFiles()?.forEach { it.delete() } }

    // ----- Páginas vigiladas -----
    fun watched(c: Context, pid: String): List<String> =
        (p(c).getString("watched_$pid", "") ?: "").lines().map { it.trim() }.filter { it.startsWith("http") }
    fun setWatched(c: Context, pid: String, l: List<String>) {
        p(c).edit().putString("watched_$pid", l.map { it.trim() }.filter { it.startsWith("http") }.distinct().joinToString("\n")).apply()
    }

    // ----- Estado de la última revisión -----
    fun status(c: Context, pid: String): String = p(c).getString("status_$pid", "Todavía no se revisó esta cuenta.") ?: ""
    fun setStatus(c: Context, pid: String, s: String) { p(c).edit().putString("status_$pid", s).apply() }
    fun flag(c: Context, pid: String, k: String): Boolean = p(c).getBoolean("f_${pid}_$k", false)
    fun setFlag(c: Context, pid: String, k: String, v: Boolean) { p(c).edit().putBoolean("f_${pid}_$k", v).apply() }

    /** Borra todo lo de una cuenta. */
    fun deleteAll(c: Context, pid: String) {
        val sp = p(c); val e = sp.edit()
        sp.all.keys.filter { it.contains("_${pid}_") || it.endsWith("_$pid") }.forEach { e.remove(it) }
        e.apply()
        File(c.filesDir, "snap/$pid").deleteRecursively()
    }
}
