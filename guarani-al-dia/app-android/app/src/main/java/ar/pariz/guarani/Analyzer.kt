package ar.pariz.guarani

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer

/** Compara cada revisión con la anterior, actualiza el tablero y dispara las notificaciones. */
class Analyzer(private val c: Context, private val prof: Profile) {
    private val pid = prof.id

    data class Change(val page: String, val added: List<String>, val removed: List<String>)

    companion object {
        private val NOISE = listOf(
            Regex("^\\d{1,2}:\\d{2}(:\\d{2})?\\s*(hs)?$", RegexOption.IGNORE_CASE),
            Regex("ultim[oa]s? (acceso|conexi|ingreso)", RegexOption.IGNORE_CASE),
            Regex("hace \\d+ (segundo|minuto|hora)", RegexOption.IGNORE_CASE),
            Regex("hora del servidor", RegexOption.IGNORE_CASE),
            Regex("^(cargando|aguarde)", RegexOption.IGNORE_CASE)
        )
        val GRADE_WORDS = Regex("(aprobad|promocion|promoción|desaprobad|ausente|libre|regular|nota|acta|calificaci|final)", RegexOption.IGNORE_CASE)
        val INSC_WORDS = Regex("(inscripci|periodo|vencimiento|vence|mesa|turno de examen|llamado|cierre|apertura)")
        private val WORD_NUM = mapOf("uno" to 1, "dos" to 2, "tres" to 3, "cuatro" to 4, "cinco" to 5, "seis" to 6,
            "siete" to 7, "ocho" to 8, "nueve" to 9, "diez" to 10)

        fun norm(s: String): String = Normalizer.normalize(s, Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "").lowercase().replace(Regex("\\s+"), " ").trim()

        fun lines(text: String): List<String> = text.lines()
            .map { it.replace(' ', ' ').replace(Regex("[ \\t]+"), " ").trim() }
            .filter { it.length >= 2 && NOISE.none { r -> r.containsMatchIn(norm(it)) } }
            .distinct()

        fun category(estado: String): String {
            val e = norm(estado)
            return when {
                e.contains("desaprob") -> "desaprobada"
                e.contains("promocion") -> "promocionada"
                e.contains("aprob") -> "aprobada"
                e.contains("ausente") -> "ausente"
                e.contains("libre") -> "libre"
                e.contains("regular") -> "regular"
                else -> "otra"
            }
        }

        fun label(cat: String): String = when (cat) {
            "desaprobada" -> "Desaprobada"; "promocionada" -> "Promocionada"; "aprobada" -> "Aprobada"
            "ausente" -> "Ausente"; "libre" -> "Libre"; "regular" -> "Regular, falta final"; else -> "En curso"
        }

        /** Línea tipo "Base de Datos (GSTI-107)": así lista Guaraní cada actividad en la historia académica. */
        private val ACTIVITY = Regex("^(.{3,120}?)\\s*\\(([A-Za-z0-9][A-Za-z0-9.\\-_/]{0,15})\\)\\s*$")

        /** Materias que aparecen en las páginas de historia académica: (nombre, código). */
        fun discoverActivities(pages: List<Pair<String, List<String>>>): List<Pair<String, String>> {
            val out = linkedMapOf<String, String>()
            for ((url, ls) in pages) {
                val isHist = norm(url).contains("historia") || ls.take(5).any { norm(it).contains("historia academica") }
                if (!isHist) continue
                for (l in ls) {
                    val m = ACTIVITY.find(l) ?: continue
                    val name = m.groupValues[1].trim().trimEnd('-', ':', '·').trim()
                    if (name.length < 3 || Regex("^\\d").containsMatchIn(name)) continue
                    if (GRADE_WORDS.matches(name)) continue
                    out.putIfAbsent(name, m.groupValues[2])
                }
            }
            return out.map { it.key to it.value }
        }

        /** Busca estado y nota de una materia dentro del texto de Guaraní. */
        fun findGrade(all: List<String>, name: String, others: List<String>): Pair<String, String?>? {
            val n = norm(name)
            val otherN = others.map { norm(it) }.filter { it != n && !n.contains(it) }
            val idx = all.indexOfFirst { norm(it).contains(n) }
            if (idx < 0) return null
            val window = StringBuilder(all[idx])
            for (j in idx + 1 until minOf(all.size, idx + 5)) {
                val ln = norm(all[j])
                if (otherN.any { ln.contains(it) }) break
                window.append(' ').append(all[j])
            }
            val w = norm(window.toString()).replace(n, " ")
            val cat = category(w)
            if (cat == "otra") return null
            val cleaned = w.replace(Regex("\\d{1,2}/\\d{1,2}/\\d{2,4}"), " ")
                .replace(Regex("[a-z]+-\\d+"), " ").replace(Regex("\\d+[.,]?\\d*\\s?%"), " ")
            var nota: String? = Regex("\\b(10|[1-9])\\s*\\((uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\\)").find(cleaned)?.groupValues?.get(1)
            if (nota == null) nota = Regex("\\((uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\\)").find(cleaned)?.groupValues?.get(1)?.let { WORD_NUM[it].toString() }
            if (nota == null) nota = Regex("(nota|calificacion)[^0-9]{0,15}\\b(10|[1-9])\\b").find(cleaned)?.groupValues?.get(2)
            if (nota == null && cat in setOf("aprobada", "promocionada", "desaprobada", "regular"))
                nota = Regex("(?<![\\d.,])\\b(10|[1-9])\\b(?![\\d.,])").find(cleaned)?.groupValues?.get(1)
            if (nota == null) nota = Regex("(nota|calificacion|concepto)[: ]+([a-e])\\b|\\(([a-e])\\)").find(cleaned)
                ?.groupValues?.let { (it[2].ifEmpty { it[3] }).uppercase() }?.ifEmpty { null }
            return cat to nota
        }
    }

    fun process(r: Scraper.Result) {
        val res = Store.resumen(c, pid)
        res.put("ultima_revision", Store.nowIso())

        if (r.menuPublico.isNotEmpty() && r.state != Scraper.State.OK) {
            val m = JSONArray()
            r.menuPublico.forEach { (t, u) -> m.put(JSONObject().put("titulo", t).put("url", u)) }
            Store.put(c, pid, "menu_publico", m)
        }
        if (r.state != Scraper.State.OK) {
            val msg = when (r.state) {
                Scraper.State.OFFLINE -> "Sin conexión con Guaraní (${r.message}). Se reintenta en la próxima revisión."
                Scraper.State.NEED_LOGIN -> "La sesión de Guaraní venció y la contraseña no está guardada: entrá desde la pestaña Guaraní."
                Scraper.State.LOGIN_FAILED -> "Guaraní rechazó el usuario o la clave. ${r.message}".trim()
                Scraper.State.CAPTCHA -> "Guaraní pide un captcha: entrá una vez desde la pestaña Guaraní."
                else -> ""
            }
            Store.setStatus(c, pid, "${Store.shortNow()} · $msg")
            if (r.state != Scraper.State.OFFLINE) {
                res.put("sesion", "vencida"); Store.putResumen(c, pid, res)
                if (!Store.flag(c, pid, "session_warned")) {
                    Store.setFlag(c, pid, "session_warned", true)
                    notify(Notifier.CH_ESTADO, "Guaraní: hay que volver a entrar", msg, tab = "web")
                }
            }
            return
        }
        Store.setFlag(c, pid, "session_warned", false)
        res.put("sesion", "ok")

        // Páginas vigiladas: suma lo que se descubrió en el menú.
        val w = Store.watched(c, pid).toMutableList()
        r.discovered.forEach { if (it !in w) w.add(it) }
        Store.setWatched(c, pid, w)

        // Menú del alumno tal como lo muestra Guaraní (para la pestaña Menú).
        if (r.menu.isNotEmpty()) {
            val m = JSONArray()
            r.menu.forEach { (t, u) -> m.put(JSONObject().put("titulo", t).put("url", u)) }
            Store.put(c, pid, "menu", m)
        }

        if (r.menuPublico.isNotEmpty()) {
            val m = JSONArray()
            r.menuPublico.forEach { (t, u) -> m.put(JSONObject().put("titulo", t).put("url", u)) }
            Store.put(c, pid, "menu_publico", m)
        }

        // 1) Cambios genéricos página por página.
        val changes = mutableListOf<Change>()
        var baseline = 0
        for (p in r.pages) {
            val now = lines(p.text)
            val old = Store.snapshot(c, pid, p.url)
            Store.setSnapshot(c, pid, p.url, now)
            if (old == null) { baseline++; continue }
            val oldSet = old.toHashSet(); val nowSet = now.toHashSet()
            val added = now.filter { it !in oldSet }
            val removed = old.filter { it !in nowSet }
            if (added.isNotEmpty() || removed.isNotEmpty()) changes.add(Change(pageName(p), added, removed))
        }

        // 2) Notas: materias de la carrera y actividades de otra propuesta.
        val allLines = r.pages.flatMap { lines(it.text) }
        val gradeMsgs = mutableListOf<String>()
        val firstRun = !Store.flag(c, pid, "first_ok")
        gradeMsgs += updateGrades("materias", "materia", allLines)
        gradeMsgs += updateGrades("diplomatura", "actividad", allLines)
        gradeMsgs += addDiscovered(r, firstRun)

        // 3) Resumen: promedio, avance y contadores.
        val joined = norm(allLines.joinToString("\n"))
        Regex("promedio[^0-9\\n]{0,40}(\\d{1,2}[.,]\\d{1,3})").find(joined)?.groupValues?.get(1)
            ?.replace(',', '.')?.toDoubleOrNull()?.let { res.put("promedio", it) }
        Regex("(avance|porcentaje)[^0-9\\n]{0,40}(\\d{1,3}(?:[.,]\\d+)?)").find(joined)?.groupValues?.get(2)
            ?.replace(',', '.')?.toDoubleOrNull()?.takeIf { it <= 100 }?.let { res.put("avance_pct", it) }
        Regex("(\\d+)\\s*mensajes?\\s*(nuevos|sin leer|no leidos)").find(joined)?.groupValues?.get(1)?.toIntOrNull()?.let { res.put("mensajes", it) }
        Regex("(\\d+)\\s*encuestas?\\s*pendientes?").find(joined)?.groupValues?.get(1)?.toIntOrNull()?.let { res.put("encuestas_pendientes", it) }
        recount(res)
        Store.putResumen(c, pid, res)

        // 4) Notificaciones.
        if (gradeMsgs.isNotEmpty()) {
            gradeMsgs.forEach { Store.addNovedad(c, pid, "Nota", it) }
            notify(Notifier.CH_NOTAS,
                if (gradeMsgs.size == 1) "Nueva nota en Guaraní" else "${gradeMsgs.size} novedades de notas",
                gradeMsgs.first(), gradeMsgs)
        }
        val notifyAll = Config.notifyAll(c)
        for (ch in changes) {
            val gradeLike = ch.added.filter { GRADE_WORDS.containsMatchIn(it) }
            val first = ch.added.firstOrNull() ?: "Se quitó: ${ch.removed.first()}"
            Store.addNovedad(c, pid, "Cambio", "${ch.page}: ${first.take(160)}")
            val detail = ch.added.map { "+ $it" } + ch.removed.take(4).map { "− $it" }
            val inscLike = ch.added.filter { INSC_WORDS.containsMatchIn(norm(it)) }
            when {
                gradeLike.isNotEmpty() && gradeMsgs.isEmpty() ->
                    notify(Notifier.CH_NOTAS, "Movimiento de notas: ${ch.page}", gradeLike.first(), detail)
                inscLike.isNotEmpty() ->
                    notify(Notifier.CH_INSC, "Inscripciones y fechas: ${ch.page}", inscLike.first(), detail, tab = "web")
                notifyAll ->
                    notify(Notifier.CH_CAMBIOS, "Cambió algo en ${ch.page}", first, detail, tab = "web")
            }
        }
        if (baseline > 0 && changes.isEmpty() && gradeMsgs.isEmpty() && !Store.flag(c, pid, "baseline_done")) {
            Store.setFlag(c, pid, "baseline_done", true)
            Store.addNovedad(c, pid, "Inicio", "La app tomó la foto inicial de ${r.pages.size} páginas de Guaraní. Desde ahora avisa cada cambio.")
        }
        Store.setFlag(c, pid, "first_ok", true)
        val total = changes.size + gradeMsgs.size
        Store.setStatus(c, pid, "${Store.shortNow()} · ${r.pages.size} páginas revisadas · " +
            if (total == 0) "sin cambios" else "$total novedad(es)")
    }

    private fun notify(ch: String, title: String, text: String, lines: List<String> = emptyList(), tab: String = "dash") {
        val t = if (Profiles.all(c).size > 1) "${prof.nombre} · $title" else title
        Notifier.notify(c, ch, t, text, lines, tab, pid)
    }

    /** Suma a la lista las materias nuevas que aparecen en la historia académica. */
    private fun addDiscovered(r: Scraper.Result, firstRun: Boolean): List<String> {
        val pages = r.pages.map { it.url to lines(it.text) }
        val found = discoverActivities(pages)
        if (found.isEmpty()) return emptyList()
        val mat = Store.arr(c, pid, "materias"); val dip = Store.arr(c, pid, "diplomatura")
        val known = (0 until mat.length()).map { norm(mat.getJSONObject(it).optString("materia")) } +
            (0 until dip.length()).map { norm(dip.getJSONObject(it).optString("actividad")) }
        val all = pages.flatMap { it.second }
        val names = found.map { it.first }
        val msgs = mutableListOf<String>()
        for ((name, code) in found) {
            if (norm(name) in known) continue
            val g = findGrade(all, name, names)
            val cat = g?.first ?: "otra"
            val nota = g?.second
            mat.put(org.json.JSONObject().put("codigo", code).put("materia", name).put("estado", label(cat))
                .put("nota", nota?.let { it.toIntOrNull() ?: it } ?: org.json.JSONObject.NULL)
                .put("fecha", Store.today()).put("detalle", "Leída de la historia académica"))
            if (!firstRun && nota != null) msgs.add("$name: ${label(cat).lowercase()} con $nota.")
        }
        Store.put(c, pid, "materias", mat)
        return msgs
    }

    private fun updateGrades(ds: String, nameField: String, all: List<String>): List<String> {
        val arr = Store.arr(c, pid, ds)
        val names = (0 until arr.length()).map { arr.getJSONObject(it).optString(nameField) }
        val msgs = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            val name = o.optString(nameField)
            if (name.isBlank()) continue
            val (cat, nota) = findGrade(all, name, names) ?: continue
            val oldCat = category(o.optString("estado"))
            val oldNota = o.opt("nota")?.toString()?.takeIf { it != "null" && it.isNotBlank() }
            val notaChanged = nota != null && nota != oldNota
            if (cat == oldCat && !notaChanged) continue
            if (cat != oldCat) o.put("estado", label(cat))
            if (nota != null) o.put("nota", nota.toIntOrNull() ?: nota)
            o.put("fecha", Store.today())
            o.put("detalle", "Actualizado por la app: ${label(cat)}${nota?.let { " con $it" } ?: ""}")
            msgs.add("$name: ${label(cat).lowercase()}${nota?.let { " con $it" } ?: ""}.")
        }
        if (msgs.isNotEmpty()) Store.put(c, pid, ds, arr)
        return msgs
    }

    private fun recount(res: JSONObject) {
        val m = Store.arr(c, pid, "materias")
        var aprob = 0; var pend = 0; var curso = 0
        for (i in 0 until m.length()) when (category(m.getJSONObject(i).optString("estado"))) {
            "aprobada", "promocionada" -> aprob++
            "regular" -> pend++
            "otra" -> curso++
        }
        res.put("aprobadas", aprob); res.put("pendientes_final", pend); res.put("en_curso", curso)
    }

    private fun pageName(p: Scraper.Page): String {
        val slug = p.url.trimEnd('/').substringAfterLast('/').substringBefore('?').replace('_', ' ')
        val t = p.title.substringBefore(" - ").trim()
        return (if (slug.isNotBlank() && slug.length < 40) slug.replaceFirstChar { it.uppercase() } else t).ifBlank { "Guaraní" }
    }

}
