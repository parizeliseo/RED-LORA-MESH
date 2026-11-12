package ar.pariz.guarani
import org.junit.Assert.*
import org.junit.Test
class AnalyzerTest {
    private val txt = """
Historia Académica
Promedio general con aplazos: 9,60
Instrumentos y Mediciones (GSTI-106)
14/11/2026 Examen 8 (Ocho) Aprobado
Legislación en Tecnologías de la Información y Comunicaciones (GSTI-104)
En curso
Estadísticas y Probabilidad (GSTI-103)
20/06/2026 Regularidad 10 (Diez) Regular
Base de Datos (GSTI-107)
11/10/2026 Promoción 10 (Diez) Promocionado
Fronteras y Desarrollo (DDF-4)
15/11/2026 Aprobado Nota: A
Última conexión 12/11/2026 13:10
""".trimIndent()
    private val names = listOf("Instrumentos y Mediciones","Legislación en Tecnologías de la Información y Comunicaciones",
        "Estadísticas y Probabilidad","Base de Datos","Fronteras y Desarrollo")
    @Test fun grades() {
        val l = Analyzer.lines(txt)
        assertFalse(l.any { it.contains("conexión") })
        assertEquals("aprobada" to "8", Analyzer.findGrade(l, "Instrumentos y Mediciones", names))
        assertNull(Analyzer.findGrade(l, "Legislación en Tecnologías de la Información y Comunicaciones", names))
        assertEquals("regular" to "10", Analyzer.findGrade(l, "Estadísticas y Probabilidad", names))
        assertEquals("promocionada" to "10", Analyzer.findGrade(l, "Base de Datos", names))
        assertEquals("aprobada" to "A", Analyzer.findGrade(l, "Fronteras y Desarrollo", names))
    }
}

class DiscoverTest {
    @Test fun activities() {
        val hist = """
Historia Académica
Análisis Matemático I (95-1121)
12/07/2026 Examen 7 (Siete) Aprobado
Física I (95-1124)
En curso
Promedio general: 7,50
""".trimIndent()
        val found = Analyzer.discoverActivities(listOf("https://x.edu.ar/autogestion/historia_academica" to Analyzer.lines(hist)))
        assertEquals(listOf("Análisis Matemático I" to "95-1121", "Física I" to "95-1124"), found)
        val other = Analyzer.discoverActivities(listOf("https://x.edu.ar/autogestion/mensajes" to Analyzer.lines("Aviso (URGENTE)")))
        assertTrue(other.isEmpty())
        assertEquals("aprobada" to "7", Analyzer.findGrade(Analyzer.lines(hist), "Análisis Matemático I", found.map { it.first }))
    }
    @Test fun urls() {
        assertEquals("https://siu.iugna.edu.ar/autogestion/", Profiles.normalizeUrl("siu.iugna.edu.ar/autogestion/acceso?auth=form"))
        assertEquals("https://www.fie.undef.edu.ar/siu/3w/", Profiles.normalizeUrl("https://www.fie.undef.edu.ar/siu/3w/acceso?auth=form"))
        assertEquals("https://guarani.unt.edu.ar/autogestion/", Profiles.normalizeUrl("https://guarani.unt.edu.ar/autogestion"))
    }
}
